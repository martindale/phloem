// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Layout of the Float32Array frame the sim worker transfers to the renderer.
 *
 *   [ header (HEADER floats) | segments (SEG_STRIDE each) | food | pulses ]
 *
 * World space is 3D, y up. All sections are 8 floats (32 bytes) per record except anchors.
 *
 * Segment: f32 x0 y0 z0 x1 y1 z1 | u16 r0 r1 | u8 alpha u8 emit u16 dist
 *   The last two float slots hold packed integers (read them through the
 *   Uint16/Uint8 views from `frameViews`, never as floats):
 *   r0, r1 = radius / SEG_R_MAX as unorm16; alpha as unorm8;
 *   emit = heat (high nibble, 0..15: growth tips / food arrival flare) | warmth (low nibble: recent activity, see sim/activity.ts);
 *   dist = growth distance of endpoint 0 from the inoculum / header[H.distMax] as unorm16 (streaming phase + flood front).
 *   Same 32 bytes as the 2D frame, so per-frame upload did not grow with z.
 *   The last header[H.ghosts] segments are afterglow ghosts of recently pruned tubes (alpha < GHOST_ALPHA, emit 0).
 * Food:    x y z radius | nutrient engulf fade seedKind   (seedKind = seed in [0,1) + 2 * kind, kind 1 = inoculum)
 *   Only files the mold has already reached are emitted (the inoculum is always record 0): an unreached file is invisible, and the
 *   bbox below ignores it too. A fresh arrival carries a short glint in `radius`/`nutrient`/`fade` (see engine.ts ARRIVE_*).
 * Pulse:   x y z intensity | dirX dirY dirZ hue
 * Anchor:  id x y z reached      (label/picking section, after the pulses; see labels/)
 *   id = logical tree node id (files and folders, live only); x y z = un-wobbled world position;
 *   reached = 1 once the vein has reached the node (folders: gate for showing a label).
 */
export const HEADER = 56;
export const SEG_STRIDE = 8;
export const FOOD_STRIDE = 8;
export const PULSE_STRIDE = 8;
export const ANCHOR_STRIDE = 5;
/** Field offsets inside an anchor / pulse record (read by src/labels; keep in sync with the layout above). */
export const A = { id: 0, x: 1, y: 2, z: 3, reached: 4 } as const;
export const P = { x: 0, y: 1, z: 2, intensity: 3, dirX: 4, dirY: 5, dirZ: 6, hue: 7 } as const;
/** Radius quantization range of the segment r0/r1 unorm16 fields (world units). */
export const SEG_R_MAX = 8;
/** Period (world units of growth distance) of the low-tier peristaltic wave (shader: sin(d * 2pi / WAVE_PERIOD - t)). */
export const WAVE_PERIOD = 69.81317;

export const H = {
  tick: 0,
  commit: 1, // index of last applied commit, -1 before the first
  segs: 2,
  food: 3,
  pulses: 4,
  minX: 5,
  minY: 6,
  maxX: 7,
  maxY: 8,
  stepMs: 9, // worker: avg ms per sim tick (EMA)
  packMs: 10, // worker: ms to pack this frame
  nodes: 11,
  edges: 12,
  ticksThisFrame: 13,
  seeking: 14, // 1 while fast-forwarding to a seek target
  totalCommits: 15,
  growthTips: 16,
  explorers: 17,
  cgIters: 18,
  ticksPerCommit: 19,
  liveFiles: 20,
  playing: 21,
  speed: 22,
  frameId: 23,
  ended: 24, // 1 once the timeline and its settling period are over
  anchors: 25, // number of anchor records
  minZ: 26,
  maxZ: 27,
  streaming: 28, // 1 while more commits may still be appended (ingestion in progress)
  waiting: 29, // 1 while the clock is held at the streaming horizon, waiting for the next commit
  // ---- visual activity signals (sim/activity.ts; 30-31 left free)
  distMax: 32, // world growth distance that the segment dist field's unorm16 1.0 stands for (power of two >= 256)
  ghosts: 33, // number of afterglow ghost segments at the end of the segment section (included in H.segs)
  hotX: 34, // activity hot-spot: weighted centroid of growth-tip heat, travelling pulses and (weakly) warmth
  hotY: 35,
  hotZ: 36,
  hotW: 37, // total weight behind the hot-spot (0 = nothing happening; ~1 per growing tip / pulse)
  hotR: 38, // RMS radius of the activity around the hot-spot (world units)
  activity: 39, // overall activity 0..1: 1 - exp(-hotW / 24) maxed with the strongest live flood (energy x remaining travel)
  bursts: 40, // BURSTS records of (landing tick, energy 0..1, author hue 0..1), newest first; energy 0 = empty slot
  reach: 52, // largest growth distance of a live node (flood waves fade out by then)
} as const;
/** Floats per burst record in the header (`H.bursts + k * BURST_STRIDE`). */
export const BURST_STRIDE = 3;

export function segOffset(): number {
  return HEADER;
}
export function foodOffset(f: Float32Array): number {
  return HEADER + f[H.segs] * SEG_STRIDE;
}
export function pulseOffset(f: Float32Array): number {
  return foodOffset(f) + f[H.food] * FOOD_STRIDE;
}
export function anchorOffset(f: Float32Array): number {
  return pulseOffset(f) + f[H.pulses] * PULSE_STRIDE;
}

/** Integer views over a frame buffer (for the packed segment fields). */
export interface FrameViews {
  u16: Uint16Array;
  u8: Uint8Array;
}

let lastBuf: ArrayBufferLike | null = null;
let lastViews: FrameViews | null = null;
/** Uint16/Uint8 views of `f`'s buffer (cached for the last buffer seen). */
export function frameViews(f: Float32Array): FrameViews {
  if (f.buffer !== lastBuf || !lastViews || f.byteOffset !== 0) {
    lastBuf = f.buffer;
    lastViews = {
      u16: new Uint16Array(f.buffer, f.byteOffset, f.length * 2),
      u8: new Uint8Array(f.buffer, f.byteOffset, f.length * 4),
    };
  }
  return lastViews;
}

/** Decode the packed fields of segment k (tests/debugging). `emit` is the heat nibble; `phase` = dist mod WAVE_PERIOD, normalized. */
export function readSegment(f: Float32Array, k: number): {
  x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; r0: number; r1: number;
  alpha: number; emit: number; warm: number; dist: number; phase: number;
} {
  const o = HEADER + k * SEG_STRIDE;
  const v = frameViews(f);
  const e = v.u8[(o + 7) * 4 + 1];
  const dist = (v.u16[(o + 7) * 2 + 1] / 65535) * f[H.distMax];
  const ph = dist / WAVE_PERIOD;
  return {
    x0: f[o], y0: f[o + 1], z0: f[o + 2], x1: f[o + 3], y1: f[o + 4], z1: f[o + 5],
    r0: (v.u16[(o + 6) * 2] / 65535) * SEG_R_MAX,
    r1: (v.u16[(o + 6) * 2 + 1] / 65535) * SEG_R_MAX,
    alpha: v.u8[(o + 7) * 4] / 255,
    emit: (e >> 4) / 15,
    warm: (e & 15) / 15,
    dist,
    phase: ph - Math.floor(ph),
  };
}
