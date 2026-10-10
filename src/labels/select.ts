// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure label logic: activity / LOD curves, fade stepping, the CPU copy of the
 * renderer's wobble, and the greedy screen-space placer. No DOM, no allocation
 * per call (the planner owns preallocated typed arrays).
 */

// ---------------------------------------------------------------- curves
/** Seconds a touched file's label stays fully on, then fades to nothing. */
export const ACTIVE_HOLD = 3.5;
export const ACTIVE_FADE = 1.8;
/** Seconds of the "just touched" flash after a commit lands on a file. */
export const FLASH_TIME = 1.1;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** 1 while a file is "active", fading linearly to 0 after `ACTIVE_HOLD` seconds. Never-touched (age = Infinity) -> 0. */
export function activity(age: number): number {
  if (!(age < ACTIVE_HOLD + ACTIVE_FADE)) return 0;
  if (age <= ACTIVE_HOLD) return 1;
  return 1 - (age - ACTIVE_HOLD) / ACTIVE_FADE;
}

/** Brief highlight in [0, 1], 1 at the moment of the touch. */
export function flash(age: number): number {
  if (!(age < FLASH_TIME) || age < 0) return age < 0 ? 1 : 0;
  const t = 1 - age / FLASH_TIME;
  return t * t;
}

/** Approximate on-screen radius (css px) of a folder's subtree: files sit ~10 world units apart. */
export function subtreeExtentPx(liveFiles: number, zoomCss: number): number {
  return Math.sqrt(Math.max(1, liveFiles)) * 10 * zoomCss;
}

/** Zoom/size level of detail for a folder label in [0, 1]: grows as its subtree grows on screen. */
export function folderLod(liveFiles: number, zoomCss: number): number {
  return smoothstep(34, 95, subtreeExtentPx(liveFiles, zoomCss));
}

/** Folder labels below this LOD are not shown at all (they fade in through the alpha ramp instead of lingering as ghosts). */
export const FOLDER_LOD_MIN = 0.12;
/** Target alpha of a shown folder label: never a faint ghost, brightening with LOD. */
export function folderAlpha(lod: number): number {
  return 0.5 + 0.5 * lod;
}

/** LOD for "ambient" file labels (files that are not active): only when zoomed in enough that names fit. */
export function ambientFileLod(zoomCss: number): number {
  return smoothstep(2.2, 4.2, zoomCss);
}

/** Importance of a folder label (higher wins collisions). */
export function folderScore(liveFiles: number, depth: number): number {
  return 8 + 6 * Math.log2(1 + liveFiles) - 0.8 * depth;
}

/** How many labels to allow at a given typical on-screen scale (css px per world unit): fewer when the whole mold is in view. */
export function labelBudget(mode: 'all' | 'active', scale: number): number {
  const t = smoothstep(0.8, 3, scale);
  return mode === 'all' ? Math.round(36 + 54 * t) : Math.round(22 + 18 * t);
}

/** Linear fade step towards `target` with separate in/out durations (seconds). */
export function stepAlpha(alpha: number, target: number, dt: number, tIn: number, tOut: number): number {
  if (target > alpha) return Math.min(target, alpha + dt / tIn);
  return Math.max(target, alpha - dt / tOut);
}

/** Frame-rate independent exponential smoothing. */
export function smoothTo(cur: number, target: number, dt: number, tau: number): number {
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/** CPU copy of the shared positional wobble in render/shaders.ts (WOBBLE). Writes the offset into `out[0..1]`. */
export function wobbleAt(x: number, y: number, t: number, amp: number, out: Float32Array | number[]): void {
  out[0] =
    amp *
    (Math.sin(x * 0.043 + t * 0.53) + Math.sin(y * 0.057 - t * 0.41 + 1.3) + 0.5 * Math.sin((x + y) * 0.13 + t * 0.9));
  out[1] =
    amp *
    (Math.sin(y * 0.047 + t * 0.47 + 2.1) + Math.sin(x * 0.061 + t * 0.37 + 4.2) + 0.5 * Math.sin((x - y) * 0.12 - t * 0.8));
}

// ---------------------------------------------------------------- placement
export const SLOT_COUNT = 8;

/**
 * Top-left offset of a label box of size (w, h) relative to its anchor for a
 * given slot: 0 right, 1 left, 2 above, 3 below, 4..7 the four diagonals.
 */
export function slotOffset(slot: number, w: number, h: number, gap: number, out: Float32Array): void {
  const d = gap * 0.75;
  switch (slot) {
    case 0: out[0] = gap; out[1] = -h / 2; break;
    case 1: out[0] = -gap - w; out[1] = -h / 2; break;
    case 2: out[0] = -w / 2; out[1] = -gap - h; break;
    case 3: out[0] = -w / 2; out[1] = gap; break;
    case 4: out[0] = d; out[1] = -d - h; break;
    case 5: out[0] = d; out[1] = d; break;
    case 6: out[0] = -d - w; out[1] = -d - h; break;
    default: out[0] = -d - w; out[1] = d; break;
  }
}

/** Boost that makes a candidate sort ahead of everything (hovered label). */
export const PIN_SCORE = 1e6;

/**
 * Greedy collision-free placer. Fill with `add()`, then `plan()`: candidates are
 * visited by descending score; each tries its preferred slot first and takes
 * the first slot whose padded rectangle is inside the view and free. Results
 * are `placed` entries in `outCand` (candidate index) / `outSlot` / `outX` / `outY`
 * (top-left of the accepted rectangle).
 */
export class LabelPlanner {
  n = 0;
  readonly capacity: number;
  key: Int32Array;
  score: Float32Array;
  ax: Float32Array;
  ay: Float32Array;
  w: Float32Array;
  h: Float32Array;
  gap: Float32Array;
  pref: Int8Array;
  order: Int32Array;
  placed = 0;
  outCand: Int32Array;
  outSlot: Int8Array;
  outX: Float32Array;
  outY: Float32Array;
  private off = new Float32Array(2);
  /** Fixed rectangles (UI chrome) labels must avoid: x, y, w, h per entry. */
  readonly obstacles: number[] = [];
  private cmp: (a: number, b: number) => number;

  constructor(capacity = 4096, maxPlaced = 256) {
    this.capacity = capacity;
    this.key = new Int32Array(capacity);
    this.score = new Float32Array(capacity);
    this.ax = new Float32Array(capacity);
    this.ay = new Float32Array(capacity);
    this.w = new Float32Array(capacity);
    this.h = new Float32Array(capacity);
    this.gap = new Float32Array(capacity);
    this.pref = new Int8Array(capacity);
    this.order = new Int32Array(capacity);
    this.outCand = new Int32Array(maxPlaced);
    this.outSlot = new Int8Array(maxPlaced);
    this.outX = new Float32Array(maxPlaced);
    this.outY = new Float32Array(maxPlaced);
    // ties broken by key so the outcome is deterministic
    this.cmp = (a, b) => this.score[b] - this.score[a] || this.key[a] - this.key[b];
  }

  reset(): void {
    this.n = 0;
    this.placed = 0;
  }

  /** Returns false when full (candidate dropped). */
  add(key: number, score: number, ax: number, ay: number, w: number, h: number, gap: number, prefSlot: number): boolean {
    const i = this.n;
    if (i >= this.capacity) return false;
    this.key[i] = key;
    this.score[i] = score;
    this.ax[i] = ax;
    this.ay[i] = ay;
    this.w[i] = w;
    this.h[i] = h;
    this.gap[i] = gap;
    this.pref[i] = prefSlot;
    this.n = i + 1;
    return true;
  }

  /** `limit` caps normal labels; pinned candidates (score >= PIN_SCORE) are always tried. */
  plan(limit: number, x0: number, y0: number, x1: number, y1: number, pad: number): void {
    const n = this.n;
    const order = this.order;
    for (let i = 0; i < n; i++) order[i] = i;
    order.subarray(0, n).sort(this.cmp);
    let placed = 0;
    let normal = 0;
    const maxPlaced = this.outCand.length;
    const off = this.off;
    for (let k = 0; k < n && placed < maxPlaced; k++) {
      const i = order[k];
      const pinned = this.score[i] >= PIN_SCORE;
      if (normal >= limit && !pinned) break;
      const w = this.w[i];
      const h = this.h[i];
      const pref = this.pref[i];
      for (let t = 0; t < SLOT_COUNT; t++) {
        // preferred slot first, then the rest in order
        const slot = t === 0 ? pref : t - 1 < pref ? t - 1 : t;
        slotOffset(slot, w, h, this.gap[i], off);
        const x = this.ax[i] + off[0];
        const y = this.ay[i] + off[1];
        if (x < x0 || y < y0 || x + w > x1 || y + h > y1) continue;
        if (this.collides(x, y, w, h, placed, pad)) continue;
        this.outCand[placed] = i;
        this.outSlot[placed] = slot;
        this.outX[placed] = x;
        this.outY[placed] = y;
        placed++;
        if (!pinned) normal++;
        break;
      }
    }
    this.placed = placed;
  }

  private collides(x: number, y: number, w: number, h: number, count: number, pad: number): boolean {
    const ox = this.outX;
    const oy = this.outY;
    const oc = this.outCand;
    const cw = this.w;
    const ch = this.h;
    const ob = this.obstacles;
    for (let j = 0; j < ob.length; j += 4) {
      if (x < ob[j] + ob[j + 2] && x + w > ob[j] && y < ob[j + 1] + ob[j + 3] && y + h > ob[j + 1]) return true;
    }
    for (let j = 0; j < count; j++) {
      const c = oc[j];
      if (x < ox[j] + cw[c] + pad && x + w + pad > ox[j] && y < oy[j] + ch[c] + pad && y + h + pad > oy[j]) return true;
    }
    return false;
  }
}
