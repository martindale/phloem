// SPDX-License-Identifier: AGPL-3.0-only
/** Pure helpers for the timeline scrubber: date ticks and a change-size sparkline. No DOM. */

export interface Tick {
  /** 0..1 along the track. */
  frac: number;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A short date label whose precision follows the span of the whole history. */
export function formatSpanDate(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const day = 86_400_000;
  if (spanMs > 2 * 365 * day) return String(d.getUTCFullYear());
  if (spanMs > 60 * day) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Full date for the readout, in the viewer's locale. */
export function formatFullDate(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Up to `count` evenly spaced ticks (by commit index, which is what the scrubber's x axis is), labelled with that commit's date.
 * Consecutive duplicate labels are dropped so a one-week history does not print "Mar 4 Mar 4 Mar 4".
 */
export function timelineTicks(dates: readonly number[], count: number): Tick[] {
  const n = dates.length;
  if (n < 2 || count < 1) return [];
  const valid = dates.filter((d) => Number.isFinite(d));
  if (valid.length < 2) return [];
  const span = Math.max(...valid) - Math.min(...valid);
  const out: Tick[] = [];
  let prev = '';
  for (let k = 0; k < count; k++) {
    const frac = count === 1 ? 0 : k / (count - 1);
    const i = Math.round(frac * (n - 1));
    const label = formatSpanDate(dates[i], span);
    if (!label || label === prev) continue;
    prev = label;
    out.push({ frac, label });
  }
  return out;
}

/** Change size per bin (files touched, max over the commits in the bin), log-scaled and normalized to 0..1. */
export function densityBins(sizes: readonly number[], bins: number): number[] {
  const n = sizes.length;
  if (n === 0 || bins < 1) return [];
  const out = new Array<number>(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor((i * bins) / n));
    out[b] = Math.max(out[b], Math.log1p(Math.max(0, sizes[i])));
  }
  const top = Math.max(...out, 1e-9);
  return out.map((v) => v / top);
}
