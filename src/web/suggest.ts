// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Autocomplete for the landing card's repository field. No DOM in here (the widget is in src/ui/landing/landing.ts).
 *
 * Sources, in this order: featured repositories (local), repositories opened before (saved histories, local), then ONE GitHub
 * request: GET https://api.github.com/search/repositories?q=<text>&per_page=6. The request goes through GithubApi, so it gets the
 * same headers, token handling and error mapping as every other call; only that host is ever contacted. Unauthenticated search is
 * limited to about 10 requests a minute, so any failure (403, 429, network, bad body) silently falls back to the local list and
 * stops searching for 60 seconds. See docs/WEB.md.
 */
import { GithubApi, type FetchLike } from '../ingest/github';

export type SuggestSource = 'featured' | 'recent' | 'search';

export interface Suggestion {
  /** owner/name, the format the input accepts. */
  repo: string;
  /** Secondary text: a note, a description or a star count. */
  detail: string;
  source: SuggestSource;
}

export const MIN_SEARCH_CHARS = 3;
export const DEBOUNCE_MS = 300;
export const BACKOFF_MS = 60_000;
export const SEARCH_PER_PAGE = 6;
export const MAX_SUGGESTIONS = 8;
const MAX_QUERY_CHARS = 100;

export interface LocalRepo {
  repo: string;
  name?: string;
  note?: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** 0 = best. Prefix of the repo or of the name beats a substring; null = no match. */
function rank(q: string, repo: string, name?: string): number | null {
  const r = repo.toLowerCase();
  const n = (name ?? '').toLowerCase();
  const short = r.slice(r.indexOf('/') + 1);
  if (r.startsWith(q) || short.startsWith(q) || n.startsWith(q)) return 0;
  if (r.includes(q) || n.includes(q)) return 1;
  return null;
}

function pick(list: readonly LocalRepo[], q: string, source: SuggestSource, detail: (l: LocalRepo) => string): Array<Suggestion & { rank: number }> {
  const out: Array<Suggestion & { rank: number }> = [];
  for (const l of list) {
    const k = rank(q, l.repo, l.name);
    if (k !== null) out.push({ repo: l.repo, detail: detail(l), source, rank: k });
  }
  return out.sort((a, b) => a.rank - b.rank); // stable: keeps the given order within a rank
}

/** Featured first, then recent, each ranked by match quality; duplicates (case-insensitive) keep their first source. */
export function localSuggestions(text: string, featured: readonly LocalRepo[], recent: readonly LocalRepo[], limit = MAX_SUGGESTIONS): Suggestion[] {
  const q = norm(text);
  if (!q) return [];
  return mergeSuggestions(
    [...pick(featured, q, 'featured', (l) => l.note ?? 'Featured, instant'), ...pick(recent, q, 'recent', () => 'Opened before')],
    limit,
  );
}

/** Concatenate lists in order, drop duplicates (case-insensitive owner/name) and cap the total. */
export function mergeSuggestions(list: readonly Suggestion[], limit = MAX_SUGGESTIONS): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const s of list) {
    const k = s.repo.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ repo: s.repo, detail: s.detail, source: s.source });
    if (out.length >= limit) break;
  }
  return out;
}

/** Search only for a plain word-like text: 3+ characters and nothing that already looks like owner/name or a URL. */
export function shouldSearch(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_SEARCH_CHARS || t.length > MAX_QUERY_CHARS) return false;
  return !/[/@#:]/.test(t) && !/github\.com/i.test(t);
}

/** Search response to suggestions. Anything unexpected is dropped, never thrown. */
export function parseSearch(json: unknown): Suggestion[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: Suggestion[] = [];
  for (const it of items) {
    const r = it as { full_name?: unknown; description?: unknown; stargazers_count?: unknown; private?: unknown };
    if (typeof r?.full_name !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(r.full_name) || r.private === true) continue;
    const stars = typeof r.stargazers_count === 'number' ? `${r.stargazers_count.toLocaleString('en-US')} stars` : '';
    const desc = typeof r.description === 'string' ? r.description.trim().slice(0, 80) : '';
    out.push({ repo: r.full_name, detail: [stars, desc].filter(Boolean).join(' · '), source: 'search' });
  }
  return out.slice(0, SEARCH_PER_PAGE);
}

/** The single GitHub request. Rejects on any failure, including abort. */
export async function searchRepos(text: string, o: { token?: string; fetch?: FetchLike; signal?: AbortSignal } = {}): Promise<Suggestion[]> {
  // no retries and no waiting: a slow or limited search is simply skipped
  const api = new GithubApi({ token: o.token, fetch: o.fetch, retries: 0, autoWaitSeconds: 0 });
  const path = `/search/repositories?q=${encodeURIComponent(text.trim())}&per_page=${SEARCH_PER_PAGE}`;
  const { json } = await api.get(path, o.signal);
  return parseSearch(json);
}

export interface SuggesterDeps {
  /** Local suggestions for the text (synchronous). */
  local(text: string): Suggestion[];
  token?(): string | undefined;
  fetch?: FetchLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** Debounce, cancellation, stale-response guard and the 60 s back-off, around searchRepos. */
export class Suggester {
  private timer: unknown = null;
  private ctl: AbortController | null = null;
  private seq = 0;
  private blockedUntil = 0;
  private now: () => number;

  constructor(private d: SuggesterDeps) {
    this.now = d.now ?? Date.now;
  }

  get backedOff(): boolean {
    return this.now() < this.blockedUntil;
  }

  /** Calls `emit` at once with the local list, and again with local + search results when the search succeeds. */
  update(text: string, emit: (list: Suggestion[]) => void): void {
    this.cancel();
    const id = ++this.seq;
    const local = this.d.local(text);
    emit(local);
    if (!shouldSearch(text) || this.backedOff) return;
    const set = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      if (id !== this.seq || this.backedOff) return;
      const ctl = (this.ctl = new AbortController());
      searchRepos(text, { token: this.d.token?.(), fetch: this.d.fetch, signal: ctl.signal }).then(
        (found) => {
          if (id !== this.seq || ctl.signal.aborted) return; // stale
          emit(mergeSuggestions([...local, ...found]));
        },
        () => {
          if (id !== this.seq || ctl.signal.aborted) return; // cancelled on purpose: not a failure
          this.blockedUntil = this.now() + BACKOFF_MS; // 403, 429, network or anything else: local only for a minute
        },
      );
    }, DEBOUNCE_MS);
  }

  /** Drop the pending timer and request, and ignore anything still in flight. */
  cancel(): void {
    if (this.timer !== null) (this.d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.ctl?.abort();
    this.ctl = null;
    this.seq++;
  }
}
