// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent, FileChange, FileStatus } from '../model/events';
import { parseCommitEvents } from '../model/parse';

/**
 * Browser-side GitHub ingestion through the REST API (api.github.com sends CORS headers, including for the
 * rate-limit headers). See docs/INGESTION.md for the limits and alternatives.
 *
 * Request cost (the whole story is the rate limit: 60/hour unauthenticated per IP, 5000/hour with a token):
 *   1 request                     repository info (default branch, private flag, validates the repo)
 *   ceil(window / 100) requests   listing commits (100 per page; the list carries parents, so the first-parent chain is built locally)
 *   1 request per commit          the commit's file list (the list endpoint does not include files)  -> mode 'commits'
 *   1 request per sample          the whole file tree at a commit, diffed against the previous sample -> mode 'snapshots'
 * 'auto' picks 'commits' when the window fits in the remaining quota and 'snapshots' otherwise.
 *
 * The token is only ever sent to https://api.github.com as an Authorization header. It is never logged, put in a URL, stored by
 * this module, or included in error messages.
 */

export const API_BASE = 'https://api.github.com';
const FILES_PER_PAGE = 300; // GET /commits/{sha} returns up to 300 files per page

// ------------------------------------------------------------------ repo reference
export interface RepoRef {
  owner: string;
  repo: string;
  branch?: string;
}

/**
 * Accepts `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo(.git)`, `.../tree/<branch>`, `owner/repo@branch`
 * and `owner/repo#branch`. Returns null when it does not look like a GitHub repository.
 */
export function parseRepoInput(input: string, branch?: string): RepoRef | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^git@github\.com:/i, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '');
  let b = branch?.trim() || undefined;
  const tree = /^([^/\s]+)\/([^/\s#@?]+)\/tree\/(.+)$/.exec(s);
  if (tree) {
    s = `${tree[1]}/${tree[2]}`;
    b = b ?? decodeURIComponent(tree[3].replace(/[?#].*$/, '').replace(/\/+$/, ''));
  }
  const at = /^([^/\s]+)\/([^/\s@#?]+)[@#](.+)$/.exec(s);
  if (at) {
    s = `${at[1]}/${at[2]}`;
    b = b ?? at[3];
  }
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(s);
  if (!m) return null;
  if (m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2], ...(b ? { branch: b } : {}) };
}

// ------------------------------------------------------------------ errors
export type GithubErrorKind = 'not-found' | 'auth' | 'rate-limit' | 'empty' | 'forbidden' | 'network' | 'api' | 'cancelled';

export class GithubError extends Error {
  constructor(
    public readonly kind: GithubErrorKind,
    message: string,
    /** Epoch ms when the rate limit resets / the retry-after expires (kind 'rate-limit'). */
    public readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

export interface RateInfo {
  limit: number;
  remaining: number;
  /** Epoch ms. */
  resetAt: number;
  resource: string;
}

// ------------------------------------------------------------------ transport
export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface ApiOptions {
  token?: string;
  fetch?: FetchLike;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Retries for network errors / 5xx (default 2). */
  retries?: number;
  /** A secondary-limit `retry-after` up to this many seconds is waited out automatically (default 15). */
  autoWaitSeconds?: number;
  onRate?: (r: RateInfo) => void;
  onWait?: (untilMs: number) => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GithubError('cancelled', 'Cancelled'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new GithubError('cancelled', 'Cancelled'));
      },
      { once: true },
    );
  });
}

export class GithubApi {
  rate: RateInfo | null = null;
  requests = 0;
  private fetchFn: FetchLike;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private now: () => number;

  constructor(private o: ApiOptions = {}) {
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
    this.sleep = o.sleep ?? defaultSleep;
    this.now = o.now ?? Date.now;
  }

  setToken(token: string | undefined): void {
    this.o = { ...this.o, token: token || undefined };
  }

  private updateRate(h: { get(name: string): string | null }): void {
    const remaining = h.get('x-ratelimit-remaining');
    const limit = h.get('x-ratelimit-limit');
    const reset = h.get('x-ratelimit-reset');
    if (remaining === null || reset === null) return;
    this.rate = {
      limit: Number(limit ?? 0),
      remaining: Number(remaining),
      resetAt: Number(reset) * 1000,
      resource: h.get('x-ratelimit-resource') ?? 'core',
    };
    this.o.onRate?.(this.rate);
  }

  /** GET `path` (e.g. `/repos/o/r/commits?per_page=100`) on api.github.com. */
  async get(path: string, signal?: AbortSignal, free = false): Promise<{ json: unknown; headers: { get(name: string): string | null } }> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (this.o.token) headers.Authorization = `Bearer ${this.o.token}`;
    const url = `${API_BASE}${path}`;
    const retries = this.o.retries ?? 2;
    let attempt = 0;
    let waited = 0;
    for (;;) {
      if (signal?.aborted) throw new GithubError('cancelled', 'Cancelled');
      // Known-exhausted quota: do not burn a request (and a 403) until the window resets.
      if (!free && this.rate && this.rate.remaining <= 0 && this.now() < this.rate.resetAt) {
        throw new GithubError('rate-limit', 'GitHub API rate limit reached.', this.rate.resetAt);
      }
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        this.requests++;
        res = await this.fetchFn(url, { headers, signal });
      } catch (e) {
        if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw new GithubError('cancelled', 'Cancelled');
        if (attempt++ < retries) {
          await this.sleep(400 * 2 ** attempt, signal);
          continue;
        }
        // Do not echo e.message verbatim: some runtimes include request details.
        throw new GithubError('network', 'Could not reach api.github.com. Check your connection (or an ad/tracking blocker) and try again.');
      }
      this.updateRate(res.headers);
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new GithubError('api', 'GitHub returned a response that is not JSON.');
        }
        return { json, headers: res.headers };
      }
      let body: { message?: string } = {};
      try {
        body = (await res.json()) as { message?: string };
      } catch {
        /* no body */
      }
      const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const exhausted = res.headers.get('x-ratelimit-remaining') === '0';
        if (retryAfter !== null) {
          const secs = Number(retryAfter) || 60;
          if (secs <= (this.o.autoWaitSeconds ?? 15) && waited < 2) {
            waited++;
            const until = this.now() + secs * 1000;
            this.o.onWait?.(until);
            await this.sleep(secs * 1000 + 250, signal);
            continue;
          }
          throw new GithubError('rate-limit', 'GitHub asked us to slow down (secondary rate limit).', this.now() + secs * 1000);
        }
        if (exhausted || /rate limit/i.test(message)) {
          const resetAt = this.rate?.resetAt && this.rate.resetAt > this.now() ? this.rate.resetAt : this.now() + 60_000;
          throw new GithubError('rate-limit', 'GitHub API rate limit reached.', resetAt);
        }
        throw new GithubError('forbidden', `GitHub refused the request: ${message}`);
      }
      if (res.status === 401) throw new GithubError('auth', 'GitHub rejected the token (bad or expired). Remove it, or create a new one.');
      if (res.status === 404) throw new GithubError('not-found', 'Repository, branch or commit not found. If the repository is private, enter a token that can read it.');
      if (res.status === 409) throw new GithubError('empty', 'This repository is empty (it has no commits).');
      if (res.status === 451) throw new GithubError('forbidden', 'This repository is unavailable for legal reasons (HTTP 451).');
      if (res.status >= 500 && attempt++ < retries) {
        await this.sleep(400 * 2 ** attempt, signal);
        continue;
      }
      throw new GithubError('api', `GitHub API error: ${message}`);
    }
  }

  /** Current core quota. GET /rate_limit does not count against the quota. */
  async fetchRate(signal?: AbortSignal): Promise<RateInfo | null> {
    const { json } = await this.get('/rate_limit', signal, true);
    const core = (json as { resources?: { core?: { limit: number; remaining: number; reset: number } } })?.resources?.core;
    if (!core) return this.rate;
    this.rate = { limit: core.limit, remaining: core.remaining, resetAt: core.reset * 1000, resource: 'core' };
    this.o.onRate?.(this.rate);
    return this.rate;
  }
}

// ------------------------------------------------------------------ cache (resume across sessions)
/** Commit details are immutable (keyed by SHA), so public-repo results can be cached and a retry after a rate limit costs nothing. */
export interface DetailCache {
  getMany(shas: string[]): Promise<Map<string, CommitEvent>>;
  put(sha: string, ev: CommitEvent): void;
}

export class MemoryCache implements DetailCache {
  map = new Map<string, CommitEvent>();
  async getMany(shas: string[]): Promise<Map<string, CommitEvent>> {
    const out = new Map<string, CommitEvent>();
    for (const s of shas) {
      const v = this.map.get(s);
      if (v) out.set(s, v);
    }
    return out;
  }
  put(sha: string, ev: CommitEvent): void {
    this.map.set(sha, ev);
  }
}

// ------------------------------------------------------------------ ingest
export type IngestMode = 'auto' | 'commits' | 'snapshots';

export interface GithubIngestOptions {
  repo: RepoRef;
  token?: string;
  /** How far back: the most recent `maxCommits` first-parent commits. */
  maxCommits: number;
  mode: IngestMode;
  /** Upper bound on snapshots in snapshot mode. */
  maxSamples?: number;
  concurrency?: number;
  /** Extra file pages followed for commits with more than 300 changed files. */
  maxFilePages?: number;
  cache?: DetailCache;
  fetch?: FetchLike;
  sleep?: ApiOptions['sleep'];
  now?: () => number;
}

export interface GithubProgress {
  phase: 'repo' | 'listing' | 'details' | 'snapshots' | 'done';
  /** Progress inside the phase. */
  done: number;
  total: number;
  /** Commits handed to the app so far. */
  delivered: number;
  /** Planned number of commit events (known after listing). */
  planned: number;
  mode: 'commits' | 'snapshots' | null;
  requests: number;
  cached: number;
  rate: RateInfo | null;
  /** Plain-language remarks (budget decisions, truncation) to show the user. */
  notes: string[];
  /** Set while sleeping on a short retry-after. */
  waitingUntil?: number;
}

export interface RunResult {
  status: 'complete' | 'rate-limited' | 'cancelled' | 'error';
  error?: GithubError;
  /** Epoch ms the quota resets (status 'rate-limited'). */
  resetAt?: number;
  delivered: number;
  planned: number;
  mode: 'commits' | 'snapshots' | null;
}

interface ListItem {
  sha: string;
  parents: string[];
  tree: string;
  message: string;
  author: string;
  email: string;
  date: string;
}

interface EventHandlers {
  onCommits(batch: CommitEvent[]): void;
  onProgress(p: GithubProgress): void;
}

const subject = (m: string): string => m.split('\n', 1)[0].trim();

export class GithubIngest {
  readonly api: GithubApi;
  private info: { defaultBranch: string; isPrivate: boolean } | null = null;
  private chain: ListItem[] = []; // newest first
  private byHash = new Map<string, ListItem>();
  private cursor: string | null = null; // next first-parent sha to resolve
  private page = 0;
  private listingDone = false;
  private plan: { mode: 'commits' | 'snapshots'; window: ListItem[]; samples: number[] } | null = null;
  private details = new Map<string, CommitEvent>();
  private cacheLoaded = false;
  private cachedCount = 0;
  private delivered = 0;
  private prevTree: Map<string, { sha: string; size: number }> | null = null;
  private prevSampleIdx = -1;
  private notes: string[] = [];
  private waitingUntil: number | undefined;
  private phase: GithubProgress['phase'] = 'repo';
  private done = 0;
  private total = 0;
  private handlers: EventHandlers | null = null;
  private now: () => number;

  constructor(readonly opts: GithubIngestOptions) {
    this.now = opts.now ?? Date.now;
    this.api = new GithubApi({
      token: opts.token,
      fetch: opts.fetch,
      sleep: opts.sleep,
      now: opts.now,
      onRate: () => this.emit(),
      onWait: (t) => {
        this.waitingUntil = t;
        this.emit();
      },
    });
  }

  private emit(): void {
    this.handlers?.onProgress({
      phase: this.phase,
      done: this.done,
      total: this.total,
      delivered: this.delivered,
      planned: this.plan ? (this.plan.mode === 'commits' ? this.plan.window.length : this.plan.samples.length) : 0,
      mode: this.plan?.mode ?? null,
      requests: this.api.requests,
      cached: this.cachedCount,
      rate: this.api.rate,
      notes: this.notes,
      waitingUntil: this.waitingUntil && this.waitingUntil > this.now() ? this.waitingUntil : undefined,
    });
  }

  private note(s: string): void {
    if (!this.notes.includes(s)) this.notes.push(s);
  }

  /** Quota requests still available (Infinity if unknown), keeping a small reserve. */
  private budget(reserve = 2): number {
    const r = this.api.rate;
    if (!r) return Infinity;
    if (this.now() >= r.resetAt) return Math.max(0, r.limit - reserve);
    return Math.max(0, r.remaining - reserve);
  }

  /**
   * Run (or resume) the ingest. Commits are delivered oldest first, in order, through `onCommits` as soon as they are
   * contiguous. Safe to call again after a rate limit, a network error or a cancel: finished work is kept.
   */
  async run(handlers: EventHandlers, signal?: AbortSignal): Promise<RunResult> {
    this.handlers = handlers;
    this.waitingUntil = undefined;
    try {
      // Resuming after a rate limit: ask GitHub for the real quota first (GET /rate_limit is free), so "try again" works as soon
      // as the quota is back, even before the reset time we last saw.
      if (this.api.rate && this.api.rate.remaining <= 0) await this.api.fetchRate(signal);
      await this.ensureInfo(signal);
      await this.ensureListing(signal);
      this.ensurePlan();
      if (this.plan!.mode === 'commits') await this.runDetails(signal);
      else await this.runSnapshots(signal);
      this.phase = 'done';
      this.emit();
      return { status: 'complete', delivered: this.delivered, planned: this.plannedCount(), mode: this.plan?.mode ?? null };
    } catch (e) {
      const err = e instanceof GithubError ? e : new GithubError('api', e instanceof Error ? e.message : String(e));
      this.emit();
      const base = { delivered: this.delivered, planned: this.plannedCount(), mode: this.plan?.mode ?? null };
      if (err.kind === 'cancelled') return { status: 'cancelled', ...base };
      if (err.kind === 'rate-limit') return { status: 'rate-limited', error: err, resetAt: err.resetAt, ...base };
      return { status: 'error', error: err, ...base };
    } finally {
      this.waitingUntil = undefined;
    }
  }

  private plannedCount(): number {
    return this.plan ? (this.plan.mode === 'commits' ? this.plan.window.length : this.plan.samples.length) : 0;
  }

  // ---------------------------------------------------------------- phase 1: repo info
  private async ensureInfo(signal?: AbortSignal): Promise<void> {
    if (this.info) return;
    this.phase = 'repo';
    this.emit();
    const { repo } = this.opts;
    const { json } = await this.api.get(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, signal);
    const r = json as { default_branch?: string; private?: boolean };
    this.info = { defaultBranch: r.default_branch ?? 'HEAD', isPrivate: r.private === true };
  }

  get isPrivate(): boolean {
    return this.info?.isPrivate ?? true;
  }

  /** The resolved detail mode once the plan exists (null before). */
  get mode(): 'commits' | 'snapshots' | null {
    return this.plan?.mode ?? null;
  }

  get branch(): string {
    return this.opts.repo.branch ?? this.info?.defaultBranch ?? 'HEAD';
  }

  // ---------------------------------------------------------------- phase 2: list commits, build the first-parent chain
  private async ensureListing(signal?: AbortSignal): Promise<void> {
    if (this.listingDone) return;
    let want = Math.max(1, Math.floor(this.opts.maxCommits));
    // Do not let listing eat a small quota: per-commit mode needs ~1 request per commit on top of the pages; the other modes need samples.
    const budget = this.budget();
    if (Number.isFinite(budget)) {
      const cap = this.opts.mode === 'commits' ? Math.floor(((budget - 1) * 100) / 101) : 100 * Math.max(1, Math.floor(budget / 2));
      if (cap < want) {
        want = Math.max(1, cap);
        this.note(`Quota: only ${Math.floor(budget)} requests left, so at most the newest ${want.toLocaleString()} commits are considered.`);
      }
    }
    // merge-heavy histories list more commits than the first-parent chain contains
    const maxPages = Math.max(2, Math.ceil(want / 100) * 4);
    this.phase = 'listing';
    this.total = want;
    const { repo } = this.opts;
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits`;
    for (;;) {
      // advance the chain through everything we have
      while (this.cursor && this.byHash.has(this.cursor) && this.chain.length < want) {
        const it = this.byHash.get(this.cursor)!;
        this.chain.push(it);
        this.cursor = it.parents[0] ?? null;
        if (!this.cursor) break;
      }
      this.done = this.chain.length;
      this.emit();
      if (this.chain.length >= want) break;
      if (this.page > 0 && !this.cursor) break; // reached the root commit
      if (this.page >= maxPages) {
        this.note(`Stopped listing after ${maxPages} pages; the history has many side branches.`);
        break;
      }
      if (this.page >= 1 && this.budget() < 1) throw new GithubError('rate-limit', 'GitHub API rate limit reached.', this.api.rate?.resetAt);
      const url = `${base}?sha=${encodeURIComponent(this.branch)}&per_page=100&page=${this.page + 1}`;
      const { json, headers } = await this.api.get(url, signal);
      const items = json as Array<{
        sha: string;
        parents?: Array<{ sha: string }>;
        commit: { message?: string; tree?: { sha: string }; author?: { name?: string; email?: string; date?: string } };
      }>;
      this.page++;
      if (this.page === 1 && items.length === 0) throw new GithubError('empty', 'This repository is empty (it has no commits).');
      for (const c of items) {
        this.byHash.set(c.sha, {
          sha: c.sha,
          parents: (c.parents ?? []).map((p) => p.sha),
          tree: c.commit.tree?.sha ?? '',
          message: c.commit.message ?? '',
          author: c.commit.author?.name ?? 'unknown',
          email: c.commit.author?.email ?? '',
          date: c.commit.author?.date ?? '',
        });
      }
      if (this.page === 1 && items.length > 0) this.cursor = items[0].sha;
      const link = headers.get('link');
      const hasNext = link === null ? items.length >= 100 : /rel="next"/.test(link);
      if (!hasNext) {
        // last page: whatever the chain could not resolve is simply missing (shallow / grafted history)
        while (this.cursor && this.byHash.has(this.cursor) && this.chain.length < want) {
          const it = this.byHash.get(this.cursor)!;
          this.chain.push(it);
          this.cursor = it.parents[0] ?? null;
        }
        break;
      }
    }
    this.listingDone = true;
    if (this.chain.length === 0) throw new GithubError('empty', 'No commits found on this branch.');
  }

  // ---------------------------------------------------------------- planning
  private ensurePlan(): void {
    if (this.plan) return;
    const window = this.chain.slice().reverse(); // oldest first
    const budget = this.budget();
    let mode: 'commits' | 'snapshots';
    if (this.opts.mode === 'commits') mode = 'commits';
    else if (this.opts.mode === 'snapshots') mode = 'snapshots';
    else mode = window.length <= budget ? 'commits' : 'snapshots';
    if (mode === 'commits') {
      let w = window;
      if (w.length > budget) {
        // the quota cannot cover the window: keep the newest commits that fit (the oldest-first prefix of the rest is not lost for good:
        // a token or a later retry fetches more, and cached details are reused)
        w = window.slice(window.length - Math.max(1, Math.floor(budget)));
        this.note(`Quota: only ${Math.floor(budget)} requests left, so just the newest ${w.length} of ${window.length} requested commits are fetched. Use snapshots mode or add a token for more.`);
      }
      this.plan = { mode, window: w, samples: [] };
    } else {
      const maxSamples = this.opts.maxSamples ?? 60;
      const s = Math.max(1, Math.min(maxSamples, window.length, Math.floor(Number.isFinite(budget) ? budget : maxSamples)));
      const samples: number[] = [];
      for (let k = 0; k < s; k++) samples.push(Math.round(((k + 1) * window.length) / s) - 1);
      this.plan = { mode, window, samples };
      if (this.opts.mode === 'auto') {
        this.note(
          `${window.length} commits do not fit the ${Number.isFinite(budget) ? Math.floor(budget) : 'available'} requests left, so the history is sampled: ${s} snapshots of the whole file tree, each shown as one combined commit.`,
        );
      }
    }
    this.total = this.plannedCount();
    this.done = 0;
  }

  // ---------------------------------------------------------------- phase 3a: per-commit file lists
  private async runDetails(signal?: AbortSignal): Promise<void> {
    const plan = this.plan!;
    const win = plan.window;
    this.phase = 'details';
    this.total = win.length;
    // reuse cached details (public repos only)
    if (!this.cacheLoaded && this.opts.cache && !this.isPrivate) {
      const got = await this.opts.cache.getMany(win.map((w) => w.sha));
      for (const [sha, ev] of got) {
        this.details.set(sha, ev);
        this.cachedCount++;
      }
      this.cacheLoaded = true;
      if (this.cachedCount > 0) this.note(`${this.cachedCount} commits were already cached from an earlier session.`);
    }
    this.flush();
    let next = this.delivered;
    let failure: GithubError | null = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure || signal?.aborted) return;
        while (next < win.length && this.details.has(win[next].sha)) next++;
        if (next >= win.length) return;
        const idx = next++;
        const item = win[idx];
        try {
          const ev = await this.fetchDetail(item, signal);
          this.details.set(item.sha, ev);
          if (!this.isPrivate) this.opts.cache?.put(item.sha, ev);
        } catch (e) {
          failure = failure ?? (e instanceof GithubError ? e : new GithubError('api', e instanceof Error ? e.message : String(e)));
          return;
        }
        this.flush();
      }
    };
    const n = Math.max(1, Math.min(this.opts.concurrency ?? 4, win.length));
    await Promise.all(Array.from({ length: n }, worker));
    this.flush();
    if (signal?.aborted) throw new GithubError('cancelled', 'Cancelled');
    if (failure) throw failure;
  }

  /** Deliver the contiguous prefix of fetched details. */
  private flush(): void {
    const win = this.plan!.window;
    const batch: CommitEvent[] = [];
    while (this.delivered < win.length) {
      const ev = this.details.get(win[this.delivered].sha);
      if (!ev) break;
      batch.push(ev);
      this.delivered++;
    }
    this.done = this.delivered;
    if (batch.length) this.handlers?.onCommits(batch);
    this.emit();
  }

  private async fetchDetail(item: ListItem, signal?: AbortSignal): Promise<CommitEvent> {
    const { repo } = this.opts;
    const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/commits/${item.sha}`;
    const { json, headers } = await this.api.get(path, signal);
    const d = json as {
      files?: Array<GhFile>;
    };
    const files: GhFile[] = d.files ?? [];
    let pages = 1;
    const maxPages = 1 + (this.opts.maxFilePages ?? 3);
    let more = files.length >= FILES_PER_PAGE && /rel="next"/.test(headers.get('link') ?? '');
    while (more && pages < maxPages) {
      pages++;
      const r = await this.api.get(`${path}?page=${pages}`, signal);
      const f = (r.json as { files?: GhFile[] }).files ?? [];
      files.push(...f);
      more = f.length >= FILES_PER_PAGE && /rel="next"/.test(r.headers.get('link') ?? '');
    }
    if (more) this.note(`Commit ${item.sha.slice(0, 7)} changes more files than could be fetched (GitHub shows at most ${maxPages * FILES_PER_PAGE} per commit here); the rest is omitted.`);
    return {
      hash: item.sha,
      author: item.author,
      email: item.email,
      date: item.date || '1970-01-01T00:00:00Z',
      message: subject(item.message),
      files: files.map(toFileChange).filter((f): f is FileChange => f !== null),
    };
  }

  // ---------------------------------------------------------------- phase 3b: tree snapshots
  private async runSnapshots(signal?: AbortSignal): Promise<void> {
    const plan = this.plan!;
    this.phase = 'snapshots';
    this.total = plan.samples.length;
    const { repo } = this.opts;
    for (let k = this.delivered; k < plan.samples.length; k++) {
      if (signal?.aborted) throw new GithubError('cancelled', 'Cancelled');
      const idx = plan.samples[k];
      const item = plan.window[idx];
      const { json } = await this.api.get(
        `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/trees/${item.tree || item.sha}?recursive=1`,
        signal,
      );
      const t = json as { tree?: GhTreeEntry[]; truncated?: boolean };
      if (t.truncated) this.note('GitHub truncated a very large file tree (over 100,000 entries); the picture is incomplete.');
      const cur = new Map<string, { sha: string; size: number }>();
      for (const e of t.tree ?? []) if (e.type === 'blob') cur.set(e.path, { sha: e.sha, size: e.size ?? 0 });
      const count = idx - this.prevSampleIdx;
      const ev: CommitEvent = {
        hash: item.sha,
        author: item.author,
        email: item.email,
        date: item.date || '1970-01-01T00:00:00Z',
        message: count > 1 ? `${subject(item.message)} (+${count - 1} earlier commits)` : subject(item.message),
        files: diffTrees(this.prevTree, cur),
      };
      this.prevTree = cur;
      this.prevSampleIdx = idx;
      this.delivered = k + 1;
      this.done = this.delivered;
      this.handlers?.onCommits([ev]);
      this.emit();
    }
  }
}

// ------------------------------------------------------------------ mapping helpers
interface GhFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  previous_filename?: string;
}
interface GhTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

function toFileChange(f: GhFile): FileChange | null {
  let status: FileStatus;
  switch (f.status) {
    case 'added':
    case 'copied':
      status = 'A';
      break;
    case 'removed':
      status = 'D';
      break;
    case 'renamed':
      status = 'R';
      break;
    case 'modified':
    case 'changed':
      status = 'M';
      break;
    default:
      return null; // 'unchanged'
  }
  const fc: FileChange = { path: f.filename, status, added: f.additions ?? 0, removed: f.deletions ?? 0 };
  if (status === 'R') {
    if (f.previous_filename) fc.old_path = f.previous_filename;
    else fc.status = 'A';
  }
  return fc;
}

const LINE_BYTES = 40; // snapshot mode has sizes, not line counts: ~40 bytes per line

/**
 * Compare two file trees (path -> blob sha/size). A deleted and an added file with the same blob are reported as one rename. Line
 * counts are estimated from sizes (git trees carry no diffs). `prev === null` means "empty": everything is an add.
 */
export function diffTrees(
  prev: ReadonlyMap<string, { sha: string; size: number }> | null,
  cur: ReadonlyMap<string, { sha: string; size: number }>,
): FileChange[] {
  const added: Array<[string, { sha: string; size: number }]> = [];
  const modified: FileChange[] = [];
  const deleted: Array<[string, { sha: string; size: number }]> = [];
  for (const [path, e] of cur) {
    const p = prev?.get(path);
    if (!p) added.push([path, e]);
    else if (p.sha !== e.sha) {
      modified.push({ path, status: 'M', added: Math.ceil(e.size / LINE_BYTES / 2), removed: Math.ceil(p.size / LINE_BYTES / 2) });
    }
  }
  if (prev) for (const [path, e] of prev) if (!cur.has(path)) deleted.push([path, e]);
  // rename detection by identical blob
  const delBySha = new Map<string, string[]>();
  for (const [path, e] of deleted) {
    const l = delBySha.get(e.sha);
    if (l) l.push(path);
    else delBySha.set(e.sha, [path]);
  }
  const out: FileChange[] = [];
  const renamedFrom = new Set<string>();
  const adds: FileChange[] = [];
  for (const [path, e] of added) {
    const cands = delBySha.get(e.sha);
    if (cands && cands.length > 0 && e.size > 0) {
      const old = cands.shift()!;
      renamedFrom.add(old);
      out.push({ path, status: 'R', added: 0, removed: 0, old_path: old });
    } else adds.push({ path, status: 'A', added: Math.max(1, Math.ceil(e.size / LINE_BYTES)), removed: 0 });
  }
  out.push(...adds, ...modified);
  for (const [path, e] of deleted) if (!renamedFrom.has(path)) out.push({ path, status: 'D', added: 0, removed: Math.max(1, Math.ceil(e.size / LINE_BYTES)) });
  return parseCommitEvents([{ hash: 'x', author: 'x', date: 'x', files: out }])[0].files;
}
