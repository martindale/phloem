// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertClean, assertPublic, authorNames, featuredFileName, indexEntry, scrubCommits, stableEntry, validateConfig } from '../scripts/featured-lib.mjs';
import { FEATURED, describeStats, featuredFile, featuredUrl, featuredWindow, fetchFeatured, loadFeaturedIndex, matchFeatured, monthYear } from '../src/web/featured';
import { parseCommitEvents } from '../src/model/parse';
import type { CommitEvent } from '../src/model/events';

const mk = (n: number, author = 'Ann', email = 'ann@example.com'): CommitEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    hash: String(i).padStart(40, '0'),
    author,
    email,
    date: `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00+00:00`,
    message: `c${i}`,
    files: [{ path: `src/f${i % 2}.ts`, status: 'M', added: 1, removed: 0 }],
  }));

const json = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response;

describe('featured config', () => {
  it('the shipped config is valid and names the three repos', () => {
    const cfg = validateConfig(JSON.parse(readFileSync('src/web/featured.config.json', 'utf8')));
    expect(cfg.map((c) => c.repo)).toEqual(['stemdeckapp/stemdeck', 'thcp/netbattle', 'Encore-Karaoke-Labs/Encore-Karaoke']);
    expect(cfg[1].name).toBe('netbattle');
    expect(cfg[2].name).toBe('Encore Karaoke');
  });
  it('rejects bad entries and lists every problem', () => {
    expect(() => validateConfig({})).toThrow();
    expect(() => validateConfig({ repos: [] })).toThrow(/no repos/);
    expect(() => validateConfig({ repos: [{ repo: 'nope', branch: 'main' }, { repo: 'a/b', branch: '--x' }] })).toThrow(/repos\[0\].repo[\s\S]*repos\[1\].branch/);
    expect(() => validateConfig({ repos: [{ repo: 'a/b', branch: 'main' }, { repo: 'A/B', branch: 'main' }] })).toThrow(/duplicate/);
    expect(() => validateConfig({ repos: [{ repo: 'a/b.git', branch: 'main' }] })).toThrow();
  });
  it('defaults the display name to the repo name', () => {
    expect(validateConfig({ repos: [{ repo: 'a/b', branch: 'main' }] })[0].name).toBe('b');
  });
  it('refuses anything not PUBLIC', () => {
    expect(() => assertPublic('PUBLIC', 'a/b')).not.toThrow();
    expect(() => assertPublic('PRIVATE', 'a/b')).toThrow(/not public/);
    expect(() => assertPublic('INTERNAL', 'a/b')).toThrow();
    expect(() => assertPublic(undefined, 'a/b')).toThrow();
  });
  it('file names agree between the generator and the app', () => {
    expect(featuredFileName('thcp/NetBattle')).toBe('thcp__netbattle.json');
    for (const f of FEATURED) expect(featuredFile(f.repo)).toBe(featuredFileName(f.repo));
    expect(featuredFileName('Encore-Karaoke-Labs/Encore-Karaoke')).toBe('encore-karaoke-labs__encore-karaoke.json');
  });
});

describe('privacy scrubbing', () => {
  it('blanks emails, keeps names, does not mutate the input', () => {
    const src = mk(2);
    const out = scrubCommits(src);
    expect(out.every((c) => c.email === '' && c.author === 'Ann')).toBe(true);
    expect(src[0].email).toBe('ann@example.com');
  });
  it('applies authorMap renames', () => {
    expect(scrubCommits(mk(1, 'Tha.Les'), { 'Tha.Les': 'Thales' })[0].author).toBe('Thales');
  });
  it('scrubbed output still parses, and the author hue key (the name) is intact', () => {
    const parsed = parseCommitEvents(JSON.parse(JSON.stringify(scrubCommits(mk(3)))));
    expect(parsed).toHaveLength(3);
    expect(parsed[0].author).toBe('Ann');
  });
  it('assertClean rejects emails, tokens and local paths', () => {
    expect(() => assertClean(JSON.stringify(scrubCommits(mk(1))), ['/home/someone'])).not.toThrow();
    expect(() => assertClean(JSON.stringify(mk(1)))).toThrow(/email/);
    expect(() => assertClean('x ghp_' + 'a'.repeat(30))).toThrow(/token/);
    expect(() => assertClean('{"message":"/home/someone/x"}', ['/home/someone'])).toThrow(/local path/);
  });
  it('lists author names by commit count', () => {
    expect(authorNames([...mk(1, 'B'), ...mk(2, 'A')])).toEqual([{ name: 'A', commits: 2 }, { name: 'B', commits: 1 }]);
  });
  it('the shipped featured files carry no emails', () => {
    for (const f of FEATURED) {
      const c = JSON.parse(readFileSync(`public/featured/${featuredFile(f.repo)}`, 'utf8')) as CommitEvent[];
      expect(c.length).toBeGreaterThan(0);
      expect(c.every((x) => x.email === '')).toBe(true);
    }
  });
  it('the bundled fixtures (shipped in the demo chunk and in the public repository) carry no emails', () => {
    for (const f of ['stemdeck-first10.json', 'stemdeck-full.json']) {
      const c = JSON.parse(readFileSync(`fixtures/${f}`, 'utf8')) as CommitEvent[];
      expect(c.length).toBeGreaterThan(0);
      expect(c.every((x) => x.email === '')).toBe(true);
    }
  });
});

describe('index entry', () => {
  it('counts commits and distinct files', () => {
    const e = indexEntry({ repo: 'a/b', name: 'bee', branch: 'main' }, mk(4), { head: 'abc', generatedAt: '2026-10-10T00:00:00Z', bytes: 99 });
    expect(e).toMatchObject({ repo: 'a/b', name: 'bee', commits: 4, files: 2, head: 'abc', bytes: 99, file: 'a__b.json' });
    expect(e.first).toContain('2026-01-01');
    expect(e.last).toContain('2026-01-04');
  });
});

describe('matching', () => {
  it('is case-insensitive on owner/name', () => {
    expect(matchFeatured({ owner: 'StemDeckApp', repo: 'STEMDECK' })?.repo).toBe('stemdeckapp/stemdeck');
    expect(matchFeatured({ owner: 'THCP', repo: 'NetBattle' })?.name).toBe('netbattle');
    expect(matchFeatured({ owner: 'encore-karaoke-labs', repo: 'ENCORE-KARAOKE' })?.name).toBe('Encore Karaoke');
  });
  it('accepts the featured branch or none, rejects another branch and other repos', () => {
    expect(matchFeatured({ owner: 'thcp', repo: 'netbattle', branch: 'main' })).not.toBeNull();
    expect(matchFeatured({ owner: 'thcp', repo: 'netbattle', branch: 'dev' })).toBeNull();
    expect(matchFeatured({ owner: 'thcp', repo: 'netfighters' })).toBeNull();
    expect(matchFeatured({ owner: 'expressjs', repo: 'express' })).toBeNull();
  });
});

describe('window', () => {
  it('max = the most recent N, all = everything', () => {
    const c = mk(10);
    expect(featuredWindow(c, 3).map((x) => x.message)).toEqual(['c7', 'c8', 'c9']);
    expect(featuredWindow(c, 'all')).toHaveLength(10);
    expect(featuredWindow(c, 500)).toHaveLength(10);
  });
});

describe('fetching and fallback', () => {
  const entry = { repo: 'a/b', name: 'bee', branch: 'main' };
  it('resolves the URL against the page base', () => {
    expect(featuredUrl('x.json', 'https://h.example/phloem/')).toBe('https://h.example/phloem/featured/x.json');
    expect(featuredUrl('x.json', 'http://localhost:4173/index.html')).toBe('http://localhost:4173/featured/x.json');
  });
  it('fetches and parses', async () => {
    const f = vi.fn(async () => json(scrubCommits(mk(3))));
    const r = await fetchFeatured(entry, { fetch: f, base: 'http://x/' });
    expect(r.commits).toHaveLength(3);
    expect(f).toHaveBeenCalledWith('http://x/featured/a__b.json', expect.anything());
  });
  it('rejects (so the app falls back to GitHub) on HTTP errors, bad JSON shape, empty or index mismatch', async () => {
    await expect(fetchFeatured(entry, { fetch: async () => json({}, false) })).rejects.toThrow();
    await expect(fetchFeatured(entry, { fetch: async () => json({ not: 'an array' }) })).rejects.toThrow();
    await expect(fetchFeatured(entry, { fetch: async () => json([]) })).rejects.toThrow(/empty/);
    await expect(fetchFeatured(entry, { fetch: async () => { throw new TypeError('network'); } })).rejects.toThrow();
    const stats = { commits: 5 } as never;
    await expect(fetchFeatured(entry, { fetch: async () => json(mk(3)), stats })).rejects.toThrow(/index/);
  });
  it('the index resolves to [] when unavailable', async () => {
    expect(await loadFeaturedIndex({ fetch: async () => json({}, false) })).toEqual([]);
    expect(await loadFeaturedIndex({ fetch: async () => { throw new Error('x'); } })).toEqual([]);
  });
  it('the index returns valid rows only', async () => {
    const rows = await loadFeaturedIndex({ fetch: async () => json({ repos: [{ repo: 'a/b', commits: 3 }, { nope: 1 }] }) });
    expect(rows).toHaveLength(1);
  });
});

describe('labels', () => {
  it('formats month ranges', () => {
    expect(monthYear('2026-05-03T11:51:20+01:00')).toBe('May 2026');
    expect(monthYear(null)).toBe('');
    expect(describeStats({ commits: 336, first: '2026-05-03T00:00:00Z', last: '2026-10-05T00:00:00Z' } as never)).toBe('336 commits, May 2026 to Oct 2026');
    expect(describeStats({ commits: 6, first: '2026-10-08T00:00:00Z', last: '2026-10-10T00:00:00Z' } as never)).toBe('6 commits, Oct 2026');
  });
});

describe('stableEntry', () => {
  const mkEntry = (head: string, generatedAt: string, commits = 4, bytes = 99) =>
    ({ repo: 'a/b', name: 'bee', branch: 'main', file: 'a__b.json', commits, files: 3, first: null, last: null, head, generatedAt, bytes }) as const;
  it('keeps the previous timestamp when head, commit count and size are unchanged (the weekly run then commits nothing)', () => {
    const prev = mkEntry('abc', '2026-10-01T00:00:00.000Z');
    expect(stableEntry(mkEntry('abc', '2026-10-08T00:00:00.000Z'), prev).generatedAt).toBe('2026-10-01T00:00:00.000Z');
  });
  it('takes the new timestamp when the repository moved, or on a first run', () => {
    const prev = mkEntry('abc', '2026-10-01T00:00:00.000Z');
    expect(stableEntry(mkEntry('def', '2026-10-08T00:00:00.000Z'), prev).generatedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(stableEntry(mkEntry('abc', '2026-10-08T00:00:00.000Z', 5), prev).generatedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(stableEntry(mkEntry('abc', '2026-10-08T00:00:00.000Z'), undefined).generatedAt).toBe('2026-10-08T00:00:00.000Z');
  });
});
