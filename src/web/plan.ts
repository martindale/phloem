// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Honest cost preview for a GitHub request, shown on the landing card before the visitor commits to anything.
 * Mirrors the planning in `src/ingest/github.ts` (listing = 1 repo request + 1 per 100 commits; detail = 1 request per commit,
 * or 1 per snapshot sample; `auto` picks commits when they fit the quota, else up to 60 snapshots). Pure, unit-tested.
 */
import { MAX_ANONYMOUS, MAX_WITH_TOKEN, resolveMax, type MaxSetting } from './urlstate';

export const QUOTA_ANONYMOUS = 60;
export const QUOTA_TOKEN = 5000;
const RESERVE = 2;
const MAX_SAMPLES = 60;

export interface PlanEstimate {
  mode: 'commits' | 'snapshots' | 'blocked';
  /** Commits in the window after the policy cap. */
  window: number;
  capped: boolean;
  /** Requests the whole run is expected to use. */
  requests: number;
  /** Hourly quota assumed. */
  quota: number;
  /** Snapshot samples (mode 'snapshots'). */
  samples: number;
  /** Full sentence(s) for screen readers and docs. */
  summary: string;
  /** One line for the card. */
  short: string;
}

const n = (x: number): string => x.toLocaleString('en-US');

/** The largest window whose every commit still fits in the hourly quota (listing pages + one detail request per commit + a small reserve). */
export function exactCommitsThatFit(quota: number): number {
  let best = 0;
  for (let w = 1; w <= quota; w++) if (1 + Math.ceil(w / 100) + w + RESERVE <= quota) best = w;
  return best;
}

export function estimatePlan(max: MaxSetting, hasToken: boolean): PlanEstimate {
  const quota = hasToken ? QUOTA_TOKEN : QUOTA_ANONYMOUS;
  const r = resolveMax(max, hasToken);
  if (max === 'all') {
    // The default. The size of the repository is not known before the first request, so this is the honest worst case: everything the
    // quota can buy as exact commits, and evenly spaced snapshots over the (capped) rest. A small repository is simply loaded in full.
    const fit = exactCommitsThatFit(quota);
    const listing = 1 + Math.ceil(r.max / 100);
    const samples = Math.max(0, Math.min(MAX_SAMPLES, quota - listing - RESERVE));
    const cap = n(r.max);
    const tail = hasToken ? '' : ' A token lifts the limit to 5,000 requests an hour.';
    const summary = `All available within your quota: a repository with up to ${n(fit)} commits is shown commit by commit; a longer one is shown as ${samples} evenly spaced snapshots of its last ${cap} commits (${n(quota)} requests an hour ${hasToken ? 'with your token' : 'without a token'}).${tail}`;
    return {
      mode: samples < 1 ? 'blocked' : 'snapshots',
      window: r.max,
      capped: false,
      requests: listing + samples,
      samples,
      quota,
      summary,
      short: `All available within your quota: every commit up to ${n(fit)}, then ${samples} evenly spaced snapshots of the last ${cap}.${hasToken ? '' : ' (60 requests an hour without a token.)'}`,
    };
  }
  const listing = 1 + Math.ceil(r.max / 100);
  const avail = quota - listing - RESERVE;
  const base = { window: r.max, capped: r.capped, quota };
  const capNote = r.capped ? ` Capped at ${n(hasToken ? MAX_WITH_TOKEN : MAX_ANONYMOUS)} commits${hasToken ? '' : ' without a token'}.` : '';
  if (r.max <= avail) {
    return {
      ...base,
      mode: 'commits',
      requests: listing + r.max,
      samples: 0,
      summary: `Every one of the ${n(r.max)} commits, about ${n(listing + r.max)} of your ${n(quota)} requests this hour.${capNote}`,
      short: `Every commit: about ${n(listing + r.max)} of ${n(quota)} requests per hour.${capNote}`,
    };
  }
  const samples = Math.max(0, Math.min(MAX_SAMPLES, avail));
  if (samples < 1) {
    const msg = `This window needs more than ${n(quota)} requests just to list the commits. Pick a smaller window.${capNote}`;
    return { ...base, mode: 'blocked', requests: listing, samples: 0, summary: msg, short: msg };
  }
  const why = hasToken
    ? `${n(r.max)} commits need more than your ${n(quota)} hourly requests`
    : `GitHub allows ${n(quota)} requests an hour without a token`;
  return {
    ...base,
    mode: 'snapshots',
    requests: listing + samples,
    samples,
    summary: `${why}, so you will see ${samples} evenly spaced snapshots of the last ${n(r.max)} commits instead of every commit.${hasToken ? '' : ' A token lifts the limit to 5,000 an hour.'}${capNote}`,
    short: hasToken
      ? `${samples} evenly spaced snapshots of the last ${n(r.max)} commits (more than your ${n(quota)} requests per hour).${capNote}`
      : `${samples} evenly spaced snapshots of the last ${n(r.max)} commits: GitHub allows ${n(quota)} requests an hour without a token.${capNote}`,
  };
}
