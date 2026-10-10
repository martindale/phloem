// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Visual activity signals shared by the sim (frame packing), the renderer (shaders mirror these formulas) and any
 * consumer of the frame header (e.g. an auto-director camera). Pure functions, no DOM, no allocation.
 *
 * - Commit bursts: every commit starts a "flood" wave that travels outward from the inoculum along the veins at
 *   FLOOD_SPEED world units per tick of growth distance. Its energy grows with the commit size on a log scale and is
 *   capped at 1, so a 142-file commit floods the whole network brightly while a one-file fix barely ripples, and
 *   nothing ever blows out (see `burstEnergy`).
 * - Warmth: a per-node scalar that pulses and fresh growth set to 1 and that decays slowly (WARM_DECAY per tick), so
 *   recently active regions run warmer and dormant ones cool down over ~10 commits.
 * - Afterglow: pruned tubes leave a fading "slime trail" ghost for GHOST_LIFE ticks.
 */

/** Flood wave front speed (world units of growth distance per sim tick). */
export const FLOOD_SPEED = 4.2;
/** Width of the bright leading edge of the flood (world units). */
export const FLOOD_FRONT = 10;
/** Decay length of the glowing wake behind the front (world units). */
export const FLOOD_WAKE = 46;
/** Number of most recent bursts carried in the frame header. */
export const BURSTS = 4;
/** Per-tick decay of node warmth (half-life ~690 ticks, ~15 commits at the default pacing). */
export const WARM_DECAY = 0.999;
/** Afterglow lifetime of a pruned tube (ticks). */
export const GHOST_LIFE = 540;
/** Ghost alpha at birth; packed ghosts always have alpha below this (the renderer tells ghosts apart by it). */
export const GHOST_ALPHA = 0.18;
/** Only tubes that were at least this thick (peak render radius, world units) leave a ghost: veins, not explorer hair. */
export const GHOST_MIN_R = 0.6;

/**
 * Energy of the burst started by a commit touching `files` files: log-scaled, 0 for an empty commit, ~0.22 for one file,
 * ~0.6 for 15 files, 1 from ~150 files on. Never above 1.
 */
export function burstEnergy(files: number): number {
  if (!(files > 0)) return 0;
  const e = Math.log1p(files) / Math.log1p(150);
  return e > 1 ? 1 : e;
}

/**
 * Flood intensity (0..1 times energy) at growth distance `d` while the front is at `front`. Sharp leading edge, long
 * glowing wake, overall fade as the wave travels so it dies out at the network's edge (`reach` = max growth distance).
 * The segment vertex shader evaluates the same formula (keep in sync with `FLOOD` in render/shaders.ts).
 */
export function floodAt(d: number, front: number, energy: number, reach: number): number {
  if (energy <= 0 || front < 0) return 0;
  const x = front - d; // > 0 behind the front
  const shape = x < 0 ? Math.exp(-(x * x) / (FLOOD_FRONT * FLOOD_FRONT)) : Math.exp(-x / FLOOD_WAKE) * 0.85 + 0.15 * Math.exp(-(x * x) / (FLOOD_FRONT * FLOOD_FRONT));
  const travel = 1 - smooth01(front / (Math.max(reach, 60) + 2 * FLOOD_WAKE));
  return energy * shape * travel;
}

/** Ticks after which a burst's flood has left a network of growth radius `reach`. */
export function floodDuration(reach: number): number {
  return (Math.max(reach, 60) + 2 * FLOOD_WAKE) / FLOOD_SPEED;
}

function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Ghost (afterglow) alpha `age` ticks after the tube was pruned; 0 once it is gone. */
export function ghostAlpha(age: number): number {
  if (age < 0 || age >= GHOST_LIFE) return 0;
  const k = 1 - age / GHOST_LIFE;
  return GHOST_ALPHA * k * k;
}

/** Pack heat and warmth (0..1 each) into the segment's emit byte: high nibble heat, low nibble warmth. */
export function packEmit(heat: number, warm: number): number {
  const h = heat <= 0 ? 0 : heat >= 1 ? 15 : (heat * 15 + 0.5) | 0;
  const w = warm <= 0 ? 0 : warm >= 1 ? 15 : (warm * 15 + 0.5) | 0;
  return (h << 4) | w;
}

/** Inverse of `packEmit`. */
export function unpackEmit(b: number): { heat: number; warm: number } {
  return { heat: (b >> 4) / 15, warm: (b & 15) / 15 };
}
