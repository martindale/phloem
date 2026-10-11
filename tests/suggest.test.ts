// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/ingest/github';
import { BACKOFF_MS, DEBOUNCE_MS, Suggester, localSuggestions, mergeSuggestions, parseSearch, searchRepos, shouldSearch, type Suggestion } from '../src/web/suggest';

const featured = [
  { repo: 'stemdeckapp/stemdeck', name: 'stemdeck', note: 'The app Phloem was built for.' },
  { repo: 'thcp/netbattle', name: 'netbattle' },
];
const recent = [{ repo: 'Foo/netbattle-fork' }, { repo: 'THCP/NetBattle' }];

const body = (names: string[]) => ({ items: names.map((n, i) => ({ full_name: n, description: `d${i}`, stargazers_count: 1234 + i })) });
function reply(status: number, json: unknown, headers: Record<string, string> = {}): ReturnType<FetchLike> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => json });
}

describe('shouldSearch', () => {
  it('needs 3 characters and a plain word', () => {
    expect(shouldSearch('ab')).toBe(false);
    expect(shouldSearch('  ab ')).toBe(false);
    expect(shouldSearch('abc')).toBe(true);
    expect(shouldSearch('slime mold')).toBe(true);
  });
  it('skips owner/name and URLs', () => {
    expect(shouldSearch('thcp/netbattle')).toBe(false);
    expect(shouldSearch('thcp/')).toBe(false);
    expect(shouldSearch('https://github.com/a/b')).toBe(false);
    expect(shouldSearch('github.com')).toBe(false);
    expect(shouldSearch('owner/name@branch')).toBe(false);
    expect(shouldSearch('x'.repeat(101))).toBe(false);
  });
});

describe('localSuggestions / mergeSuggestions', () => {
  it('lists featured before recent and dedupes case-insensitively', () => {
    const r = localSuggestions('net', featured, recent);
    expect(r.map((s) => [s.repo, s.source])).toEqual([
      ['thcp/netbattle', 'featured'],
      ['Foo/netbattle-fork', 'recent'],
    ]);
  });
  it('matches the display name and returns nothing for empty or unmatched text', () => {
    expect(localSuggestions('STEM', featured, []).map((s) => s.repo)).toEqual(['stemdeckapp/stemdeck']);
    expect(localSuggestions('  ', featured, recent)).toEqual([]);
    expect(localSuggestions('zzz', featured, recent)).toEqual([]);
  });
  it('ranks a prefix match before a substring match within a source', () => {
    const r = localSuggestions('deck', [], [{ repo: 'a/my-deck' }, { repo: 'b/deckhand' }]);
    expect(r.map((s) => s.repo)).toEqual(['b/deckhand', 'a/my-deck']);
  });
  it('caps the merged list', () => {
    const many: Suggestion[] = Array.from({ length: 20 }, (_, i) => ({ repo: `a/r${i}`, detail: '', source: 'search' }));
    expect(mergeSuggestions(many)).toHaveLength(8);
  });
});

describe('parseSearch / searchRepos', () => {
  it('keeps valid public names and ignores junk', () => {
    const r = parseSearch({ items: [{ full_name: 'a/b', stargazers_count: 1500, description: ' hi ' }, { full_name: 'bad name' }, { full_name: 'c/d', private: true }, null, 5] });
    expect(r).toEqual([{ repo: 'a/b', detail: '1,500 stars · hi', source: 'search' }]);
    expect(parseSearch(null)).toEqual([]);
    expect(parseSearch({ items: 'x' })).toEqual([]);
  });
  it('sends exactly one GET to the search endpoint, with the token only as a header', async () => {
    const f = vi.fn((_url: string, _init?: { headers?: Record<string, string> }) => reply(200, body(['a/b'])));
    const r = await searchRepos('slime mold', { token: 'tok', fetch: f });
    expect(r.map((s) => s.repo)).toEqual(['a/b']);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('https://api.github.com/search/repositories?q=slime%20mold&per_page=6');
    expect(f.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/vnd.github+json', Authorization: 'Bearer tok' });
  });
  it('sends no Authorization header without a token', async () => {
    const f = vi.fn((_u: string, _i?: { headers?: Record<string, string> }) => reply(200, body([])));
    await searchRepos('abc', { fetch: f });
    expect(f.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/vnd.github+json' });
  });
});

describe('Suggester', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (f: FetchLike) => {
    let t = 0;
    const s = new Suggester({ local: (x) => localSuggestions(x, featured, recent), fetch: f, now: () => t });
    return { s, advance: (ms: number) => (t += ms) };
  };
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  };

  it('emits local at once, then local plus search after the debounce', async () => {
    const f = vi.fn(() => reply(200, body(['x/netty', 'thcp/netbattle'])));
    const { s } = make(f);
    const out: string[][] = [];
    s.update('net', (l) => out.push(l.map((x) => x.repo)));
    expect(out).toEqual([['thcp/netbattle', 'Foo/netbattle-fork']]);
    expect(f).not.toHaveBeenCalled();
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(out[1]).toEqual(['thcp/netbattle', 'Foo/netbattle-fork', 'x/netty']);
  });

  it('debounces: only the last of several keystrokes queries', async () => {
    const f = vi.fn((_u: string) => reply(200, body([])));
    const { s } = make(f as unknown as FetchLike);
    for (const t of ['net', 'netb', 'netba']) {
      s.update(t, () => {});
      await vi.advanceTimersByTimeAsync(100);
    }
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toContain('q=netba&');
  });

  it('does not query for short text or owner/name', async () => {
    const f = vi.fn(() => reply(200, body([])));
    const { s } = make(f);
    s.update('ne', () => {});
    s.update('thcp/net', () => {});
    await flush();
    expect(f).not.toHaveBeenCalled();
  });

  it('aborts the previous request and ignores its stale answer', async () => {
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const f: FetchLike = (_url, init) => {
      signals.push(init!.signal!);
      if (signals.length === 1) return new Promise((res) => (release = () => res({ ok: true, status: 200, headers: { get: () => null }, json: async () => body(['old/one']) })));
      return reply(200, body(['new/two']));
    };
    const { s } = make(f);
    const out: string[][] = [];
    const emit = (l: Suggestion[]) => out.push(l.map((x) => x.repo));
    s.update('abc', emit);
    await flush();
    s.update('abcd', emit);
    expect(signals[0].aborted).toBe(true);
    release();
    await flush();
    const all = out.flat();
    expect(all).toContain('new/two');
    expect(all).not.toContain('old/one');
  });

  it('on 403 falls back silently and stops querying for 60 s', async () => {
    const f = vi.fn(() => reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }));
    const { s, advance } = make(f);
    const out: string[][] = [];
    s.update('abc', (l) => out.push(l.map((x) => x.repo)));
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(s.backedOff).toBe(true);
    expect(out).toHaveLength(1); // no further emit, no error surfaced
    s.update('abcd', () => {});
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    advance(BACKOFF_MS + 1);
    expect(s.backedOff).toBe(false);
    s.update('abcde', () => {});
    await flush();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('treats 429, network errors and server errors as failures too', async () => {
    const fetchers: FetchLike[] = [() => reply(429, {}), () => Promise.reject(new TypeError('Failed to fetch')), () => reply(500, {})];
    for (const f of fetchers) {
      const { s } = make(f);
      s.update('abc', () => {});
      await flush();
      expect(s.backedOff).toBe(true);
    }
  });

  it('cancel() aborts without starting a back-off', async () => {
    const f: FetchLike = (_u, init) => new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const { s } = make(f);
    s.update('abc', () => {});
    await flush();
    s.cancel();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.backedOff).toBe(false);
  });
});
