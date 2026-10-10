// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Render quality tiers and the automatic downgrade governor. Pure logic (no DOM, no GL): unit-tested.
 *
 *   high   : everything (granular two-way streaming inside the veins, peristaltic radius pulse, gel material,
 *            commit floods, afterglow ghosts, 1800 floating motes)
 *   medium : streaming as brightness waves only (no granules), radius pulse, gel, floods, ghosts, 600 motes
 *   low    : ~ the pre-effects cost: the legacy brightness wave, floods (vertex-shader only), colour-by-meaning, no
 *            gel/ghosts/motes/radius pulse
 *
 * `?quality=high|medium|low` pins a tier; no param or `?quality=auto` starts at high and lets the governor step down.
 */

export type QualityTier = 'low' | 'medium' | 'high';
export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];

export interface Effects {
  /** 0: legacy brightness wave; 1: thickness-tuned two-way streaming + breathing; 2: plus flowing granules in the core. */
  streaming: 0 | 1 | 2;
  /** Veins swell with the streaming wave, the slow breathing and the flood (vertex shader). */
  radiusPulse: boolean;
  /** Translucent gel material: dense amber core, pale warm rim, inner scattering, thickness-aware transmittance. */
  gel: boolean;
  /** Commit floods: bright waves running outward from the inoculum (vertex shader). */
  flood: boolean;
  /** Fading afterglow of pruned veins (extra translucent instances). */
  ghosts: boolean;
  /** Number of floating motes (0 = off). */
  particles: number;
}

const TIERS: Record<QualityTier, Effects> = {
  low: { streaming: 0, radiusPulse: false, gel: false, flood: true, ghosts: false, particles: 0 },
  medium: { streaming: 1, radiusPulse: true, gel: true, flood: true, ghosts: true, particles: 600 },
  high: { streaming: 2, radiusPulse: true, gel: true, flood: true, ghosts: true, particles: 1800 },
};

/** A fresh copy of the effect set of a tier. */
export function tierEffects(t: QualityTier): Effects {
  return { ...TIERS[t] };
}

/** Parse the `?quality=` URL param: a tier name pins it, anything else (or nothing) means auto starting at high. */
export function parseQuality(v: string | null | undefined): { tier: QualityTier; auto: boolean } {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high') return { tier: s, auto: false };
  return { tier: 'high', auto: true };
}

/** The next cheaper tier, or null at the bottom. */
export function lowerTier(t: QualityTier): QualityTier | null {
  const i = QUALITY_TIERS.indexOf(t);
  return i > 0 ? QUALITY_TIERS[i - 1] : null;
}

export interface GovernorOptions {
  /** GPU time per frame (ms, from EXT_disjoint_timer_query) above which the tier is too expensive. */
  gpuBudgetMs: number;
  /** Frame-time fallback: too slow when the smoothed frame interval exceeds this many display refresh intervals... */
  slowFactor: number;
  /** ...and is also above this absolute floor (ms), so a 30 Hz display or a busy page is not punished. */
  slowFloorMs: number;
  /** The condition must hold this long (ms) before stepping down. */
  sustainMs: number;
  /** Ignore samples for this long (ms) after start and after every change (shader compiles, uploads). */
  warmupMs: number;
  /** Frame intervals longer than this (ms) are ignored (hidden tab, debugger, page load hitches). */
  maxDtMs: number;
}

export const DEFAULT_GOVERNOR: GovernorOptions = {
  gpuBudgetMs: 12,
  slowFactor: 1.45,
  slowFloorMs: 22,
  sustainMs: 2500,
  warmupMs: 3000,
  maxDtMs: 1000,
};

/**
 * Steps the quality tier down when the GPU (or, without a timer query, the frame rate) stays over budget.
 * It never steps back up on its own: an oscillating tier is worse than a stable one.
 * Feed it one `frame()` call per requestAnimationFrame. No allocation per call.
 */
export class QualityGovernor {
  tier: QualityTier;
  readonly auto: boolean;
  readonly opts: GovernorOptions;
  /** Smoothed GPU ms (-1 until a timer sample arrived) and frame interval ms. */
  gpuMs = -1;
  dtMs = -1;
  /**
   * Estimated display refresh interval (ms): the smallest frame interval seen, slowly forgotten (monitor switches).
   * Without a GPU timer, "slow" means slow relative to this, so a 30 Hz display is not mistaken for an overloaded GPU.
   */
  refreshMs = 1000;
  /** Why the last downgrade happened ('' if none). */
  reason = '';
  downgrades = 0;
  private last = -1;
  private holdUntil = -1;
  private overSince = -1;
  private gpuSeen = -1;

  constructor(init: { tier: QualityTier; auto: boolean }, opts: Partial<GovernorOptions> = {}) {
    this.tier = init.tier;
    this.auto = init.auto;
    this.opts = { ...DEFAULT_GOVERNOR, ...opts };
  }

  /**
   * One frame at wall time `now` (ms). `gpuMs` is the latest GPU timer result (-1 if unavailable) and `gpuSeq` a counter
   * that changes whenever a new result arrived (so a stale value is not counted twice). Returns the new tier when it
   * changes, else null.
   */
  frame(now: number, gpuMs = -1, gpuSeq = -1): QualityTier | null {
    const o = this.opts;
    const prev = this.last;
    this.last = now;
    if (!this.auto) return null;
    if (this.holdUntil < 0) this.holdUntil = now + o.warmupMs;
    if (prev < 0) return null;
    const dt = now - prev;
    if (!(dt > 0) || dt > o.maxDtMs) return null;
    // refresh estimate: follows drops at once, creeps up slowly (a min that forgets)
    if (dt < this.refreshMs) this.refreshMs = Math.max(4, dt * 0.5 + this.refreshMs * 0.5);
    else this.refreshMs = Math.min(50, this.refreshMs + (dt - this.refreshMs) * 0.0003);
    if (now < this.holdUntil) {
      this.dtMs = -1;
      this.gpuMs = -1;
      this.overSince = -1;
      return null;
    }
    this.dtMs = this.dtMs < 0 ? dt : this.dtMs * 0.92 + dt * 0.08;
    if (gpuMs >= 0 && gpuSeq !== this.gpuSeen) {
      this.gpuSeen = gpuSeq;
      this.gpuMs = this.gpuMs < 0 ? gpuMs : this.gpuMs * 0.85 + gpuMs * 0.15;
    }
    let over: string | null = null;
    if (this.gpuMs >= 0) {
      if (this.gpuMs > o.gpuBudgetMs) over = `gpu ${this.gpuMs.toFixed(1)} ms > ${o.gpuBudgetMs} ms`;
    } else if (this.dtMs > this.refreshMs * o.slowFactor && this.dtMs > o.slowFloorMs) {
      over = `frame ${this.dtMs.toFixed(1)} ms (refresh ${this.refreshMs.toFixed(1)} ms)`;
    }
    if (!over) {
      this.overSince = -1;
      return null;
    }
    if (this.overSince < 0) this.overSince = now;
    if (now - this.overSince < o.sustainMs) return null;
    const lower = lowerTier(this.tier);
    this.overSince = -1;
    if (!lower) return null;
    this.tier = lower;
    this.reason = over;
    this.downgrades++;
    this.holdUntil = now + o.warmupMs;
    return lower;
  }

  /** Short status for the stats overlay. */
  get label(): string {
    return `${this.tier}${this.auto ? ' (auto)' : ''}${this.reason ? ` - dropped: ${this.reason}` : ''}`;
  }
}
