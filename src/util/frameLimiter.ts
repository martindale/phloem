// SPDX-License-Identifier: AGPL-3.0-only
export const DEFAULT_MAX_FPS = 100;

/** Parse `?fps=N`: clamp 10..240; 0/off = uncapped (returns 0). */
export function parseMaxFps(raw: string | null, def = DEFAULT_MAX_FPS): number {
  if (raw === null) return def;
  const s = raw.trim().toLowerCase();
  if (s === 'off' || s === '0') return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return def;
  if (n === 0) return 0;
  return Math.min(240, Math.max(10, n));
}

export interface FrameLimiter {
  /** True if a frame stamped `now` (ms, rAF timestamp) should render. */
  shouldRender(now: number): boolean;
  readonly maxFps: number;
}

export function createFrameLimiter(maxFps: number, toleranceMs = 1): FrameLimiter {
  const interval = maxFps > 0 ? 1000 / maxFps : 0;
  let last = -Infinity;
  return {
    maxFps,
    shouldRender(now: number): boolean {
      if (interval === 0) return true;
      const elapsed = now - last;
      if (elapsed < interval - toleranceMs) return false;
      // Keep the remainder so pacing stays even; resync after a long stall.
      last = elapsed >= interval * 2 ? now : last + interval;
      if (last > now) last = now;
      return true;
    },
  };
}
