// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Featured repositories: prebuilt, rate-limit-free histories shipped as static JSON (public/featured/, built by
 * scripts/build-featured.mjs from src/web/featured.config.json). A request for one of them is served by a same-origin fetch with zero
 * GitHub API calls; any failure falls back to the normal GitHub path. See docs/WEB.md.
 */
import type { RepoRef } from '../ingest/github';
import type { CommitEvent } from '../model/events';
import { parseCommitEvents } from '../model/parse';
import config from './featured.config.json';
import type { MaxSetting } from './urlstate';

export interface FeaturedEntry {
  repo: string; // owner/name as configured
  name: string; // display name
  branch: string;
  note?: string;
}

/** One entry of public/featured/index.json. */
export interface FeaturedStats {
  repo: string;
  name: string;
  branch: string;
  file: string;
  commits: number;
  files: number;
  first: string | null;
  last: string | null;
  head: string;
  generatedAt: string;
  bytes: number;
}

export const FEATURED: readonly FeaturedEntry[] = (config as { repos: FeaturedEntry[] }).repos;

/** Same file name rule as scripts/featured-lib.mjs. */
export function featuredFile(repo: string): string {
  return `${repo.replace('/', '__')}.json`.toLowerCase();
}

/** The featured entry a request refers to: owner/name case-insensitive, branch absent or equal to the featured branch. */
export function matchFeatured(ref: Pick<RepoRef, 'owner' | 'repo' | 'branch'>, list: readonly FeaturedEntry[] = FEATURED): FeaturedEntry | null {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  for (const e of list) {
    if (e.repo.toLowerCase() !== key) continue;
    if (ref.branch && ref.branch !== e.branch) return null;
    return e;
  }
  return null;
}

/** Window of a featured load: the most recent N commits of the prebuilt history; an unset or `all` window shows everything. */
export function featuredWindow(commits: CommitEvent[], max: MaxSetting): CommitEvent[] {
  return max === 'all' ? commits : commits.slice(-Math.max(1, max));
}

/** Absolute URL of a file under featured/, relative to the page (works with vite `base: './'` and under any path). */
export function featuredUrl(file: string, base: string = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI): string {
  return new URL(`featured/${file}`, base).href;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, f: FetchFn): Promise<unknown> {
  const res = await f(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The prebuilt history of one entry, parsed and validated like any other input. Rejects on any problem (the caller falls back to GitHub). */
export async function fetchFeatured(
  entry: FeaturedEntry,
  o: { fetch?: FetchFn; base?: string; stats?: FeaturedStats | null } = {},
): Promise<{ commits: CommitEvent[] }> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const commits = parseCommitEvents(await getJson(featuredUrl(featuredFile(entry.repo), o.base), f));
  if (commits.length === 0) throw new Error('empty prebuilt history');
  // a half-written or stale file must not masquerade as the repository: the index knows how many commits to expect
  if (o.stats && o.stats.commits !== commits.length) throw new Error('prebuilt history does not match its index');
  return { commits };
}

let indexPromise: Promise<FeaturedStats[]> | null = null;

/** index.json (small), memoized; resolves to [] when it cannot be fetched so the landing simply shows no numbers. */
export function loadFeaturedIndex(o: { fetch?: FetchFn; base?: string } = {}): Promise<FeaturedStats[]> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const p = (async () => {
    try {
      const j = (await getJson(featuredUrl('index.json', o.base), f)) as { repos?: unknown };
      return Array.isArray(j.repos) ? (j.repos as FeaturedStats[]).filter((r) => r && typeof r.repo === 'string' && typeof r.commits === 'number') : [];
    } catch {
      return [];
    }
  })();
  if (!o.fetch) indexPromise = indexPromise ?? p;
  return o.fetch ? p : indexPromise!;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "May 2026" from an ISO date (the date as written, no timezone shift). */
export function monthYear(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso ?? '');
  return m ? `${MONTHS[+m[2] - 1] ?? '?'} ${m[1]}` : '';
}

/** "336 commits, May 2026 to Oct 2026" */
export function describeStats(s: FeaturedStats | undefined): string {
  if (!s) return '';
  const a = monthYear(s.first);
  const b = monthYear(s.last);
  const span = a && b ? (a === b ? a : `${a} to ${b}`) : '';
  return `${s.commits.toLocaleString('en-US')} commits${span ? `, ${span}` : ''}`;
}

export function generatedDay(s: Pick<FeaturedStats, 'generatedAt'> | undefined): string {
  return s ? s.generatedAt.slice(0, 10) : '';
}
