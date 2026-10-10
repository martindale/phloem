// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import { GithubIngest, type GithubIngestOptions, type GithubProgress, type RunResult } from './github';
import { openDetailCache } from './idbcache';
import type { FromIngest } from './ingest.worker';

/**
 * Orchestrates one loading session (an uploaded file or a GitHub repository) and reports to a `Sink` (what the app does with commits)
 * and to a status callback (what the UI shows). No DOM in here.
 */
export interface Sink {
  /** First commits of a new history; replaces whatever is loaded. `estimate` is the expected total (0 if unknown). */
  begin(label: string, first: CommitEvent[], estimate: number): void;
  /** More commits, oldest first. */
  append(batch: CommitEvent[]): void;
  /** No more commits will arrive in this session (done, failed or cancelled). */
  end(): void;
}

export interface LoadStatus {
  state: 'running' | 'done' | 'rate-limited' | 'cancelled' | 'error';
  /** Headline. */
  message: string;
  /** Second line (counts, quota). */
  detail?: string;
  notes?: string[];
  /** 0..1 when the total is known. */
  fraction?: number;
  delivered: number;
  /** Epoch ms the GitHub quota resets. */
  resetAt?: number;
  canResume?: boolean;
  /** True when nothing was delivered (the UI should show the error in the form). */
  empty?: boolean;
}

export type FileSource = { file: Blob; name: string } | { text: string; name: string };

export type GithubRequest = Omit<GithubIngestOptions, 'cache' | 'fetch' | 'sleep' | 'now'>;

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatIn(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 90) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

export class Loader {
  private worker: Worker | null = null;
  private abort: AbortController | null = null;
  private ingest: GithubIngest | null = null;
  private delivered = 0;
  private begun = false;
  private gen = 0;
  private lastGh: GithubProgress | null = null;

  constructor(
    private sink: Sink,
    private onStatus: (s: LoadStatus) => void,
  ) {}

  get active(): boolean {
    return this.worker !== null || this.abort !== null;
  }

  /** What the current GitHub session learned about its repository (null for files and before the repo check): used to decide if a finished load may be saved. */
  get githubInfo(): { isPrivate: boolean; branch: string; mode: 'commits' | 'snapshots' | null } | null {
    const g = this.ingest;
    return g ? { isPrivate: g.isPrivate, branch: g.branch, mode: g.mode } : null;
  }

  get canResume(): boolean {
    return this.ingest !== null && !this.active;
  }

  /** Stop whatever is running without reporting (a new load is about to replace it). */
  stop(): void {
    this.gen++;
    this.worker?.terminate();
    this.worker = null;
    this.abort?.abort();
    this.abort = null;
    this.ingest = null;
  }

  cancel(): void {
    if (!this.active) return;
    const had = this.delivered;
    const gh = this.ingest;
    this.gen++;
    this.worker?.terminate();
    this.worker = null;
    this.abort?.abort();
    this.abort = null;
    if (!gh) this.ingest = null;
    this.sink.end();
    this.onStatus({
      state: 'cancelled',
      message: had > 0 ? `Cancelled. Showing the ${had.toLocaleString()} commits loaded so far.` : 'Cancelled.',
      delivered: had,
      canResume: gh !== null,
      empty: had === 0,
    });
  }

  // ------------------------------------------------------------ files
  loadFile(src: FileSource): void {
    this.stop();
    const gen = this.gen;
    this.delivered = 0;
    this.begun = false;
    const label = src.name;
    const w = new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    this.onStatus({ state: 'running', message: `Reading ${src.name}…`, delivered: 0 });
    w.onmessage = (ev: MessageEvent<FromIngest>) => {
      if (gen !== this.gen) return;
      const m = ev.data;
      if (m.type === 'batch') {
        const p = m.progress;
        const est = p.expectedCommits ?? (p.bytes > 0 ? Math.round((p.totalBytes * p.commits) / p.bytes) : 0);
        if (!this.begun) {
          this.begun = true;
          this.sink.begin(label, m.commits, Math.max(est, m.commits.length));
        } else this.sink.append(m.commits);
        this.delivered += m.commits.length;
        this.onStatus({
          state: 'running',
          message: `Reading ${src.name}…`,
          detail: `${this.delivered.toLocaleString()} commits parsed (${Math.min(100, Math.round((100 * p.bytes) / Math.max(1, p.totalBytes)))}%)`,
          fraction: p.totalBytes > 0 ? p.bytes / p.totalBytes : undefined,
          delivered: this.delivered,
        });
      } else if (m.type === 'done') {
        this.finishWorker();
        this.sink.end();
        const skipped = m.result.skippedLines;
        this.onStatus({
          state: 'done',
          message: `Loaded ${m.result.commits.toLocaleString()} commits from ${src.name}.`,
          notes: [
            ...(m.result.truncated ? [`The file has more commits than the ${m.result.truncated?.toLocaleString()} Phloem keeps. Reading stopped there; add -n 20000 (or --since=2.years) to the git log command for the most recent ones.`] : []),
            ...(skipped > 0 ? [`${skipped.toLocaleString()} lines of the file were not recognised and were skipped.`] : []),
          ],
          delivered: this.delivered,
        });
      } else {
        const had = this.delivered;
        this.finishWorker();
        if (this.begun) this.sink.end();
        this.onStatus({ state: 'error', message: m.message, delivered: had, empty: had === 0 });
      }
    };
    w.onerror = (e) => {
      if (gen !== this.gen) return;
      this.finishWorker();
      if (this.begun) this.sink.end();
      this.onStatus({ state: 'error', message: `The file reader failed: ${e.message || 'unknown error'}`, delivered: this.delivered, empty: !this.begun });
    };
    w.postMessage('file' in src ? { type: 'file', file: src.file } : { type: 'text', text: src.text });
  }

  private finishWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  // ------------------------------------------------------------ GitHub
  async loadGithub(req: GithubRequest): Promise<void> {
    this.stop();
    this.delivered = 0;
    this.begun = false;
    this.lastGh = null;
    const cache = await openDetailCache();
    this.ingest = new GithubIngest({ ...req, cache });
    this.runGithub();
  }

  /** Continue a GitHub session after a rate limit, a network error or a cancel. */
  resume(): void {
    if (!this.ingest || this.active) return;
    this.runGithub();
  }

  private runGithub(): void {
    const ing = this.ingest!;
    const gen = ++this.gen;
    const ac = new AbortController();
    this.abort = ac;
    const name = `${ing.opts.repo.owner}/${ing.opts.repo.repo}`;
    this.onStatus({ state: 'running', message: `Contacting GitHub for ${name}…`, delivered: this.delivered });
    ing
      .run(
        {
          onCommits: (batch) => {
            if (gen !== this.gen) return;
            const planned = this.lastGh?.planned ?? 0;
            if (!this.begun) {
              this.begun = true;
              this.sink.begin(`${name}${ing.branch !== 'HEAD' ? `@${ing.branch}` : ''}`, batch, Math.max(planned, batch.length));
            } else this.sink.append(batch);
            this.delivered += batch.length;
          },
          onProgress: (p) => {
            if (gen !== this.gen) return;
            this.lastGh = p;
            this.onStatus(describeGithub(p, name));
          },
        },
        ac.signal,
      )
      .then((r) => {
        if (gen !== this.gen) return;
        this.abort = null;
        this.sink.end();
        this.onStatus(describeResult(r, this.lastGh, name));
        if (r.status === 'complete') this.ingest = null;
      });
  }
}

// ------------------------------------------------------------------ status text
function quotaLine(p: GithubProgress): string {
  const r = p.rate;
  if (!r) return `${p.requests} requests used`;
  return `${p.requests} requests used here, ${r.remaining} of ${r.limit} left this hour (resets ${formatClock(r.resetAt)}, in ${formatIn(r.resetAt)})`;
}

export function describeGithub(p: GithubProgress, name: string): LoadStatus {
  let message: string;
  let fraction: number | undefined;
  switch (p.phase) {
    case 'repo':
      message = `Checking ${name} on GitHub…`;
      break;
    case 'listing':
      message = `Listing commits of ${name}… ${p.done.toLocaleString()} found`;
      fraction = p.total > 0 ? p.done / p.total : undefined;
      break;
    case 'details':
      message = `Fetching file lists: commit ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
      fraction = p.total > 0 ? p.done / p.total : undefined;
      break;
    case 'snapshots':
      message = `Fetching file-tree snapshots: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
      fraction = p.total > 0 ? p.done / p.total : undefined;
      break;
    default:
      message = `Loaded ${p.delivered.toLocaleString()} ${p.mode === 'snapshots' ? 'snapshots' : 'commits'} from ${name}.`;
      fraction = 1;
  }
  const bits = [quotaLine(p)];
  if (p.cached > 0) bits.push(`${p.cached} from cache`);
  if (p.waitingUntil) bits.push(`waiting ${formatIn(p.waitingUntil)} (GitHub asked us to slow down)`);
  return { state: p.phase === 'done' ? 'done' : 'running', message, detail: bits.join(' · '), notes: p.notes, fraction, delivered: p.delivered };
}

export function describeResult(r: RunResult, p: GithubProgress | null, name: string): LoadStatus {
  const notes = p?.notes ?? [];
  const unit = r.mode === 'snapshots' ? 'snapshots' : 'commits';
  const base = { notes, delivered: r.delivered, detail: p ? quotaLine(p) : undefined, empty: r.delivered === 0 };
  switch (r.status) {
    case 'complete':
      return {
        state: 'done',
        message:
          r.mode === 'snapshots'
            ? `Loaded ${r.delivered} snapshots of ${name} (each one combines the commits between samples).`
            : `Loaded ${r.delivered.toLocaleString()} commits from ${name}.`,
        ...base,
      };
    case 'rate-limited': {
      const when = r.resetAt ? `The quota resets at ${formatClock(r.resetAt)} (in ${formatIn(r.resetAt)}). ` : '';
      return {
        state: 'rate-limited',
        message:
          r.delivered > 0
            ? `GitHub rate limit reached after ${r.delivered.toLocaleString()} of ${r.planned.toLocaleString()} ${unit}. ${when}What was fetched is shown; resume then, or add a token for 5000 requests/hour.`
            : `GitHub rate limit reached before anything could be loaded. ${when}Unauthenticated requests share 60 per hour per network address; wait, or add a token for 5000 requests/hour.`,
        resetAt: r.resetAt,
        canResume: true,
        ...base,
      };
    }
    case 'cancelled':
      return { state: 'cancelled', message: `Cancelled after ${r.delivered.toLocaleString()} ${unit}.`, canResume: true, ...base };
    default:
      return {
        state: 'error',
        message: r.error?.message ?? 'Loading failed.',
        canResume: r.error?.kind === 'network',
        ...base,
      };
  }
}
