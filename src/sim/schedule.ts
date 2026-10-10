// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';

/**
 * When does each commit land on the simulation clock?
 *
 * `even`  : commit i lands at tick i * ticksPerCommit (the original behaviour).
 * `dates` : the gap before commit i follows the real author-date gap, compressed so idle weeks do not stall playback
 *           and bursts stay quick: gap = ticksPerCommit * clamp(0.3 + 0.9 * log10(1 + hours), 0.3, 4).
 *           0 h -> 0.3 tpc, 1 h -> 0.57, 1 day -> 1.56, 1 week -> 2.3, 1 year and beyond -> 3.85..4.
 *           A commit dated before its predecessor (rebases, clock skew) counts as a 0 h gap.
 *
 * The landing tick of commit i depends only on commits 0..i, so the schedule can be extended as commits are appended and
 * snapshots of the simulation stay valid.
 */
export type Pacing = 'even' | 'dates';

/**
 * Commits with more files than this are applied over several consecutive ticks (CHUNK_FILES per tick) instead of in one step, so a
 * huge commit (initial import, vendoring, mass rename) cannot freeze a frame. The schedule leaves the next commit at least that many
 * ticks, so a commit is always fully applied before its successor lands.
 */
export const CHUNK_FILES = 300;

export function applyTicks(c: CommitEvent): number {
  return Math.max(1, Math.ceil(c.files.length / CHUNK_FILES));
}

export const PACING_MIN_FACTOR = 0.3;
export const PACING_MAX_FACTOR = 4;

export function minGapTicks(pacing: Pacing, tpc: number): number {
  return pacing === 'dates' ? Math.max(1, Math.round(PACING_MIN_FACTOR * tpc)) : tpc;
}

export function gapTicks(pacing: Pacing, tpc: number, prevMs: number, curMs: number): number {
  if (pacing === 'even') return tpc;
  const hours = Math.max(0, curMs - prevMs) / 3_600_000;
  const f = Math.min(PACING_MAX_FACTOR, Math.max(PACING_MIN_FACTOR, PACING_MIN_FACTOR + 0.9 * Math.log10(1 + hours)));
  return Math.max(1, Math.round(f * tpc));
}

/** Milliseconds of an ISO date, or NaN. */
export function dateMs(c: CommitEvent): number {
  return Date.parse(c.date);
}

/** Extend `sched` (landing ticks) and `times` (author-date ms, last valid carried forward) to cover `commits`. */
export function extendSchedule(commits: readonly CommitEvent[], sched: number[], times: number[], pacing: Pacing, tpc: number): void {
  for (let i = sched.length; i < commits.length; i++) {
    let t = dateMs(commits[i]);
    if (Number.isNaN(t)) t = i > 0 ? times[i - 1] : 0;
    if (i === 0) sched.push(0);
    else sched.push(sched[i - 1] + Math.max(applyTicks(commits[i - 1]), gapTicks(pacing, tpc, times[i - 1], t)));
    times.push(t);
  }
}

/**
 * Default ticks per commit for a history of `n` commits: 45 (about 0.75 s per commit at 1x) up to ~400 commits, then shrinking so the
 * whole replay stays around 5 minutes at 1x (18000 ticks) instead of hours: 1000 commits -> 18, 5000 -> 4, 20000 and up -> 2.
 * Explicit `?tpc=` always wins.
 */
export function autoTicksPerCommit(n: number): number {
  return Math.max(2, Math.min(45, Math.round(18000 / Math.max(1, n))));
}
