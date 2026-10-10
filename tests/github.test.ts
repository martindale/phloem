// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { GithubApi, GithubIngest, MemoryCache, diffTrees, parseRepoInput, type FetchLike, type GithubProgress } from '../src/ingest/github';
import type { CommitEvent } from '../src/model/events';
import { parseCommitEvents } from '../src/model/parse';

// ---------------------------------------------------------------- mock api.github.com
interface MockOpts {
  commits: number;
  /** every k-th first-parent commit is a merge of a side-branch commit (listed too, not on the first-parent chain) */
  mergeEvery?: number;
  limit?: number;
  isPrivate?: boolean;
  token?: string;
  resetAt?: number;
  now?: () => number;
  bigCommitAt?: number;
  failAfter?: number; // network error after this many requests
  /** after this many requests something else (another tab, a script) uses up the rest of the quota */
  drainAt?: number;
  status?: Record<string, number>;
}

function mockGithub(o: MockOpts) {
  const log: Array<{ url: string; auth: string | undefined }> = [];
  let remaining = o.limit ?? 5000;
  const limit = o.limit ?? 5000;
  const resetAt = o.resetAt ?? Date.now() + 3_600_000;
  const chain: string[] = []; // first-parent chain oldest first
  const all: Array<{ sha: string; parents: string[]; i: number; side: boolean }> = [];
  const sha = (n: string) => n.padStart(40, '0');
  for (let i = 0; i < o.commits; i++) {
    const s = sha(`c${i}`);
    let parents = i === 0 ? [] : [chain[i - 1]];
    if (o.mergeEvery && i > 0 && i % o.mergeEvery === 0) {
      const side = sha(`s${i}`);
      all.push({ sha: side, parents: [chain[i - 1]], i: i - 0.5, side: true });
      parents = [chain[i - 1], side];
    }
    chain.push(s);
    all.push({ sha: s, parents, i, side: false });
  }
  const listed = all.slice().sort((a, b) => b.i - a.i); // newest first, side commits interleaved
  const headers = (extra: Record<string, string> = {}) => {
    const h: Record<string, string> = {
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(Math.floor(resetAt / 1000)),
      'x-ratelimit-resource': 'core',
      ...extra,
    };
    return { get: (n: string) => h[n.toLowerCase()] ?? null };
  };
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: headers(extra),
    json: async () => body,
  });
  const fetch: FetchLike = async (url, init) => {
    log.push({ url, auth: init?.headers?.Authorization });
    if (init?.signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (o.failAfter !== undefined && log.length > o.failAfter) throw new TypeError('Failed to fetch');
    if (o.drainAt !== undefined && log.length > o.drainAt) remaining = 0;
    const u = new URL(url);
    const path = u.pathname;
    if (path === '/rate_limit') return reply(200, { resources: { core: { limit, remaining, reset: Math.floor(resetAt / 1000) } } });
    if (o.status?.[path]) return reply(o.status[path], { message: 'boom' });
    if (remaining <= 0) return reply(403, { message: 'API rate limit exceeded for 1.2.3.4.' });
    remaining--;
    if (o.token && init?.headers?.Authorization !== `Bearer ${o.token}`) return reply(401, { message: 'Bad credentials' });
    let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (m) {
      if (m[2] === 'missing') return reply(404, { message: 'Not Found' });
      return reply(200, { default_branch: 'main', private: o.isPrivate === true });
    }
    m = /^\/repos\/[^/]+\/[^/]+\/commits$/.exec(path);
    if (m) {
      if (o.commits === 0) return reply(409, { message: 'Git Repository is empty.' });
      const page = Number(u.searchParams.get('page') ?? 1);
      const per = Number(u.searchParams.get('per_page') ?? 30);
      const slice = listed.slice((page - 1) * per, page * per);
      const hasNext = page * per < listed.length;
      return reply(
        200,
        slice.map((c) => ({
          sha: c.sha,
          parents: c.parents.map((p) => ({ sha: p })),
          commit: { message: `message of ${c.sha.slice(0, 6)}\n\nbody`, tree: { sha: `tree-${c.sha}` }, author: { name: `Dev ${c.i % 3}`, email: 'd@x', date: new Date(Date.UTC(2023, 0, 1) + c.i * 86400000).toISOString() } },
        })),
        hasNext ? { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` } : {},
      );
    }
    m = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-z]+)$/.exec(path);
    if (m) {
      const idx = chain.indexOf(m[1]);
      const page = Number(u.searchParams.get('page') ?? 1);
      let files: unknown[] = [
        { filename: `src/file${idx}.ts`, status: 'added', additions: 10, deletions: 0 },
        ...(idx > 0 ? [{ filename: `src/file${idx - 1}.ts`, status: 'modified', additions: 2, deletions: 1 }] : []),
        ...(idx === 3 ? [{ filename: 'new name.ts', previous_filename: 'old name.ts', status: 'renamed', additions: 0, deletions: 0 }] : []),
      ];
      let link: Record<string, string> = {};
      if (idx === o.bigCommitAt) {
        const total = 700;
        files = Array.from({ length: 300 }, (_, k) => ({ filename: `big/f${(page - 1) * 300 + k}.txt`, status: 'added', additions: 1, deletions: 0 })).slice(0, Math.min(300, total - (page - 1) * 300));
        if (page * 300 < total) link = { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` };
      }
      return reply(200, { sha: m[1], files }, link);
    }
    m = /^\/repos\/[^/]+\/[^/]+\/git\/trees\/(.+)$/.exec(path);
    if (m) {
      const idx = chain.indexOf(m[1].replace('tree-', ''));
      const tree = [{ path: 'src', type: 'tree', sha: 't' }];
      for (let k = 0; k <= idx; k++) tree.push({ path: `src/file${k}.ts`, type: 'blob', sha: `blob${k}${k === idx || k === idx - 1 ? idx : ''}`, size: 400 } as never);
      return reply(200, { tree, truncated: false });
    }
    return reply(404, { message: 'Not Found' });
  };
  return { fetch, log, chain, remaining: () => remaining, refill: () => { remaining = limit; o.drainAt = undefined; } };
}

const noSleep = async () => {};

async function runAll(ing: GithubIngest, signal?: AbortSignal) {
  const got: CommitEvent[] = [];
  const progress: GithubProgress[] = [];
  const result = await ing.run({ onCommits: (b) => got.push(...b), onProgress: (p) => progress.push(p) }, signal);
  return { got, progress, result };
}

describe('parseRepoInput', () => {
  it('accepts the usual spellings', () => {
    expect(parseRepoInput('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoInput('github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoInput('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoInput('https://www.github.com/o/my.repo/')).toEqual({ owner: 'o', repo: 'my.repo' });
    expect(parseRepoInput('https://github.com/o/r/tree/feature/x?tab=1')).toEqual({ owner: 'o', repo: 'r', branch: 'feature/x' });
    expect(parseRepoInput('o/r@dev')).toEqual({ owner: 'o', repo: 'r', branch: 'dev' });
    expect(parseRepoInput('o/r', 'main')).toEqual({ owner: 'o', repo: 'r', branch: 'main' });
    expect(parseRepoInput('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
  });
  it('rejects non-repos', () => {
    for (const bad of ['', 'justaword', 'https://gitlab.com/a/b/c/d/e/', '../x', 'a b/c']) expect(parseRepoInput(bad), bad).toBeNull();
  });
});

describe('GitHub ingestion (mocked api.github.com)', () => {
  const repo = { owner: 'o', repo: 'r' };

  it('lists the first-parent chain (ignoring side branches) and fetches commit files oldest first', async () => {
    const mock = mockGithub({ commits: 12, mergeEvery: 4 });
    const ing = new GithubIngest({ repo, maxCommits: 100, mode: 'commits', fetch: mock.fetch, sleep: noSleep });
    const { got, result } = await runAll(ing);
    expect(result).toMatchObject({ status: 'complete', delivered: 12, planned: 12, mode: 'commits' });
    expect(got.map((c) => c.hash)).toEqual(mock.chain); // oldest first, no side commits
    expect(got[0].message).toBe(`message of ${mock.chain[0].slice(0, 6)}`);
    expect(got[3].files).toContainEqual({ path: 'new name.ts', status: 'R', old_path: 'old name.ts', added: 0, removed: 0 });
    expect(got[5].files[0]).toEqual({ path: 'src/file5.ts', status: 'A', added: 10, removed: 0 });
    expect(parseCommitEvents(JSON.parse(JSON.stringify(got)))).toEqual(got); // valid CommitEvents
  });

  it('paginates the commit list (100 per page) and honours the "last N commits" window', async () => {
    const mock = mockGithub({ commits: 250 });
    const ing = new GithubIngest({ repo, maxCommits: 130, mode: 'snapshots', maxSamples: 5, fetch: mock.fetch, sleep: noSleep });
    const { got, result } = await runAll(ing);
    expect(result.status).toBe('complete');
    const listCalls = mock.log.filter((l) => /\/commits\?/.test(l.url));
    expect(listCalls).toHaveLength(2); // 130 first-parent commits need 2 pages of 100
    expect(listCalls[0].url).toContain('per_page=100');
    expect(got).toHaveLength(5);
    expect(got[4].hash).toBe(mock.chain[249]); // newest commit is the last sample
    expect(got[0].files.length).toBeGreaterThan(1); // first sample = everything it contains, as adds
  });

  it('snapshots mode diffs whole trees (adds, modifies, rename-by-blob, deletes) and notes squashed commits', () => {
    const t1 = new Map([
      ['a.ts', { sha: '1', size: 400 }],
      ['b.ts', { sha: '2', size: 800 }],
      ['c.ts', { sha: '3', size: 80 }],
      ['gone.ts', { sha: '4', size: 80 }],
    ]);
    const t2 = new Map([
      ['a.ts', { sha: '1', size: 400 }],
      ['b.ts', { sha: '22', size: 1200 }],
      ['moved/c.ts', { sha: '3', size: 80 }],
      ['new.ts', { sha: '5', size: 40 }],
    ]);
    const d = diffTrees(t1, t2);
    expect(d.find((f) => f.status === 'R')).toMatchObject({ path: 'moved/c.ts', old_path: 'c.ts' });
    expect(d.find((f) => f.path === 'b.ts')).toMatchObject({ status: 'M' });
    expect(d.find((f) => f.path === 'new.ts')).toMatchObject({ status: 'A' });
    expect(d.find((f) => f.path === 'gone.ts')).toMatchObject({ status: 'D' });
    expect(d.find((f) => f.path === 'a.ts')).toBeUndefined();
    expect(diffTrees(null, t1)).toHaveLength(4);
  });

  it('auto mode falls back to snapshots when the request budget cannot cover every commit, and says why', async () => {
    const mock = mockGithub({ commits: 120, limit: 60 });
    const ing = new GithubIngest({ repo, maxCommits: 120, mode: 'auto', fetch: mock.fetch, sleep: noSleep });
    const { got, progress, result } = await runAll(ing);
    expect(result).toMatchObject({ status: 'complete', mode: 'snapshots' });
    expect(got.length).toBeLessThanOrEqual(60);
    expect(got.length).toBeGreaterThan(30);
    expect(mock.log.length).toBeLessThanOrEqual(60);
    expect(progress.at(-1)!.notes.join(' ')).toMatch(/sampled/);
    // the last snapshot message mentions the squashed commits
    expect(got[1].message).toMatch(/earlier commits/);
  });

  it('auto mode uses per-commit details when they fit', async () => {
    const mock = mockGithub({ commits: 20, limit: 60 });
    const { result, got } = await runAll(new GithubIngest({ repo, maxCommits: 20, mode: 'auto', fetch: mock.fetch, sleep: noSleep }));
    expect(result.mode).toBe('commits');
    expect(got).toHaveLength(20);
    expect(mock.log.length).toBe(1 + 1 + 20);
  });

  it('stops cleanly on the rate limit with partial results, reset time, then resumes without refetching', async () => {
    let now = 1_000_000;
    const mock = mockGithub({ commits: 40, limit: 5000, resetAt: 1_500_000, drainAt: 18 });
    const ing = new GithubIngest({ repo, maxCommits: 40, mode: 'commits', fetch: mock.fetch, sleep: noSleep, now: () => now, concurrency: 3 });
    const first = await runAll(ing);
    expect(first.result.status).toBe('rate-limited');
    expect(first.result.resetAt).toBe(1_500_000);
    expect(first.result.delivered).toBeGreaterThan(5);
    expect(first.result.delivered).toBeLessThan(40);
    // contiguous, oldest-first prefix
    expect(first.got.map((c) => c.hash)).toEqual(mock.chain.slice(0, first.got.length));
    const counted = () => mock.log.filter((l) => !l.url.includes('/rate_limit')).length;
    const used = counted();
    // until the reset, no request is wasted (only the free /rate_limit check)
    const again = await runAll(ing);
    expect(again.result.status).toBe('rate-limited');
    expect(counted()).toBe(used);
    // after the reset the quota is back; resume delivers the rest exactly once
    now = 1_600_000;
    mock.refill();
    const second = await runAll(ing);
    expect(second.result.status).toBe('complete');
    expect([...first.got, ...second.got].map((c) => c.hash)).toEqual(mock.chain);
    // fetched-but-undelivered details were kept: no commit was requested twice
    const detailCalls = mock.log.filter((l) => /\/commits\/[0-9a-z]{40}/.test(l.url)).map((l) => l.url);
    expect(new Set(detailCalls).size).toBe(40);
    expect(detailCalls.length).toBeLessThanOrEqual(40 + 4); // at most the in-flight failures were repeated
  });

  it('fits a per-commit window to the remaining quota (newest commits) instead of failing', async () => {
    const mock = mockGithub({ commits: 100, limit: 30 });
    const { result, got, progress } = await runAll(new GithubIngest({ repo, maxCommits: 100, mode: 'commits', fetch: mock.fetch, sleep: noSleep }));
    expect(result.status).toBe('complete');
    expect(got.length).toBeGreaterThan(15);
    expect(got.length).toBeLessThan(30);
    expect(got.at(-1)!.hash).toBe(mock.chain[99]);
    expect(progress.at(-1)!.notes.join(' ')).toMatch(/newest/);
    expect(mock.log.length).toBeLessThanOrEqual(30);
  });

  it('a huge window on a small quota does not spend the quota on listing: pages and samples share the budget', async () => {
    const mock = mockGithub({ commits: 3500, limit: 60 });
    const { result, got, progress } = await runAll(new GithubIngest({ repo, maxCommits: 100000, mode: 'snapshots', fetch: mock.fetch, sleep: noSleep }));
    expect(result.status).toBe('complete');
    expect(mock.log.length).toBeLessThanOrEqual(60);
    expect(got.length).toBeGreaterThanOrEqual(20);
    expect(progress.at(-1)!.notes.join(' ')).toMatch(/Quota/);
  });

  it('cancel stops requests and keeps what was delivered', async () => {
    const mock = mockGithub({ commits: 60 });
    const ac = new AbortController();
    const ing = new GithubIngest({ repo, maxCommits: 60, mode: 'commits', fetch: mock.fetch, sleep: noSleep, concurrency: 2 });
    const got: CommitEvent[] = [];
    const result = await ing.run(
      {
        onCommits: (b) => {
          got.push(...b);
          if (got.length >= 10) ac.abort();
        },
        onProgress: () => {},
      },
      ac.signal,
    );
    expect(result.status).toBe('cancelled');
    expect(got.length).toBeGreaterThanOrEqual(10);
    expect(got.length).toBeLessThan(20);
    const n = mock.log.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.log.length).toBe(n);
  });

  it('follows extra file pages for commits with more than 300 files', async () => {
    const mock = mockGithub({ commits: 4, bigCommitAt: 2 });
    const { got } = await runAll(new GithubIngest({ repo, maxCommits: 10, mode: 'commits', fetch: mock.fetch, sleep: noSleep }));
    expect(got[2].files).toHaveLength(700);
    expect(mock.log.filter((l) => l.url.includes('?page=')).length).toBeGreaterThanOrEqual(2);
  });

  it('caches public-repo details so a second session spends no detail requests; private repos are never cached', async () => {
    const cache = new MemoryCache();
    const m1 = mockGithub({ commits: 10 });
    await runAll(new GithubIngest({ repo, maxCommits: 10, mode: 'commits', fetch: m1.fetch, sleep: noSleep, cache }));
    expect(cache.map.size).toBe(10);
    const m2 = mockGithub({ commits: 10 });
    const { got } = await runAll(new GithubIngest({ repo, maxCommits: 10, mode: 'commits', fetch: m2.fetch, sleep: noSleep, cache }));
    expect(got).toHaveLength(10);
    expect(m2.log.filter((l) => /commits\/[0-9a-z]{40}/.test(l.url))).toHaveLength(0);
    const priv = new MemoryCache();
    await runAll(new GithubIngest({ repo, maxCommits: 5, mode: 'commits', fetch: mockGithub({ commits: 5, isPrivate: true }).fetch, sleep: noSleep, cache: priv }));
    expect(priv.map.size).toBe(0);
  });
});

describe('errors', () => {
  const repo = { owner: 'o', repo: 'r' };
  it('404 -> not-found with a hint about private repos', async () => {
    const mock = mockGithub({ commits: 3 });
    const { result } = await runAll(new GithubIngest({ repo: { owner: 'o', repo: 'missing' }, maxCommits: 5, mode: 'auto', fetch: mock.fetch, sleep: noSleep }));
    expect(result.status).toBe('error');
    expect(result.error!.kind).toBe('not-found');
    expect(result.error!.message).toMatch(/private/);
  });
  it('empty repository (409)', async () => {
    const { result } = await runAll(new GithubIngest({ repo, maxCommits: 5, mode: 'auto', fetch: mockGithub({ commits: 0 }).fetch, sleep: noSleep }));
    expect(result.error!.kind).toBe('empty');
  });
  it('bad token (401) and the token never appears in messages or URLs', async () => {
    const secret = 'ghp_SECRET_TOKEN_VALUE';
    const mock = mockGithub({ commits: 3, token: 'ghp_other' });
    const { result } = await runAll(new GithubIngest({ repo, token: secret, maxCommits: 5, mode: 'auto', fetch: mock.fetch, sleep: noSleep }));
    expect(result.error!.kind).toBe('auth');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(mock.log.every((l) => !l.url.includes(secret))).toBe(true);
    expect(mock.log.every((l) => l.url.startsWith('https://api.github.com/'))).toBe(true);
  });
  it('sends the token only as an Authorization header to api.github.com', async () => {
    const mock = mockGithub({ commits: 4, token: 'tok' });
    const { result } = await runAll(new GithubIngest({ repo, token: 'tok', maxCommits: 5, mode: 'commits', fetch: mock.fetch, sleep: noSleep }));
    expect(result.status).toBe('complete');
    expect(mock.log.every((l) => l.auth === 'Bearer tok' && l.url.startsWith('https://api.github.com/'))).toBe(true);
    const anon = mockGithub({ commits: 2 });
    await runAll(new GithubIngest({ repo, maxCommits: 2, mode: 'commits', fetch: anon.fetch, sleep: noSleep }));
    expect(anon.log.every((l) => l.auth === undefined)).toBe(true);
  });
  it('network errors are retried, then reported without leaking details', async () => {
    const mock = mockGithub({ commits: 5, failAfter: 1 });
    const { result } = await runAll(new GithubIngest({ repo, maxCommits: 5, mode: 'commits', fetch: mock.fetch, sleep: noSleep }));
    expect(result.status).toBe('error');
    expect(result.error!.kind).toBe('network');
    expect(mock.log.length).toBe(1 + 3); // one ok request + 1 try + 2 retries
  });
  it('secondary rate limit with a short retry-after is waited out; a long one is reported with its reset time', async () => {
    let calls = 0;
    const waits: number[] = [];
    const base = mockGithub({ commits: 3 });
    const f: FetchLike = async (url, init) => {
      calls++;
      if (calls === 2) return { ok: false, status: 403, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '3' : null) }, json: async () => ({ message: 'secondary rate limit' }) };
      return base.fetch(url, init);
    };
    const api = new GithubApi({ fetch: f, sleep: async (ms) => void waits.push(ms), now: () => 10_000 });
    await api.get('/repos/o/r');
    await api.get('/repos/o/r');
    expect(waits).toEqual([3250]);
    const long: FetchLike = async () => ({ ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '600' : null) }, json: async () => ({ message: 'slow down' }) });
    await expect(new GithubApi({ fetch: long, sleep: noSleep, now: () => 10_000 }).get('/x')).rejects.toMatchObject({ kind: 'rate-limit', resetAt: 610_000 });
  });
});
