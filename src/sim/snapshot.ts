// SPDX-License-Identifier: AGPL-3.0-only
import type { Simulation } from './engine';
import { Network } from './network';

/**
 * Seek checkpoints: periodic deep copies of a running Simulation, so scrubbing backwards on a long history restores the
 * nearest earlier snapshot and replays only the remainder instead of replaying from tick 0.
 *
 * `cloneSimulation` is a generic structural deep clone (typed arrays, arrays, Maps, Sets, class instances; shared and cyclic
 * references preserved), so new simulation state is captured automatically. It deliberately does NOT copy `commits` and
 * `sched` (append-only, derived from the commits and shared by every snapshot), which also keeps snapshots valid when commits are
 * appended later: the state at tick t depends only on the commits that landed before t.
 */

const SHARED_KEYS = new Set(['commits', 'sched', 'times']);

export interface Cloned<T> {
  value: T;
  /** Approximate heap size of the copy (typed array bytes + 8 B per array slot + object overhead). */
  bytes: number;
}

/**
 * Solver scratch of `Network`: rebuilt by every solve, and deliberately NOT carried over by `Network.allocNodes/allocEdges` when the arrays
 * grow (they come back zeroed), so the code already tolerates losing them at any tick. Snapshots leave them out (about half of a
 * snapshot's bytes) and `reviveScratch` re-creates them zeroed. The seek determinism tests (bit-identical to sequential play, across
 * compactions) guard this list: a field that actually carried state would make them fail.
 */
const NET_SCRATCH_F64_NODE = ['diag', 'rhs', 'res', 'zz', 'dd', 'qq', 'jx', 'jC'];
const NET_SCRATCH_I32_NODE = ['jIdx', 'jNode', 'jPar', 'loopDeg', 'order', 'stack', 'markHops'];
const NET_SCRATCH_EDGE = [
  ['la', 'i32'],
  ['lb', 'i32'],
  ['lg', 'f64'],
] as const;
const NET_SCRATCH = new Set<string>([...NET_SCRATCH_F64_NODE, ...NET_SCRATCH_I32_NODE, ...NET_SCRATCH_EDGE.map((e) => e[0])]);

/** Give a restored simulation back its (zeroed) solver scratch. */
export function reviveScratch(sim: Simulation): void {
  const net = sim.net as unknown as Record<string, unknown> & { nodeCap: number; edgeCap: number };
  for (const k of NET_SCRATCH_F64_NODE) net[k] = new Float64Array(net.nodeCap);
  for (const k of NET_SCRATCH_I32_NODE) net[k] = new Int32Array(net.nodeCap);
  for (const [k, t] of NET_SCRATCH_EDGE) net[k] = t === 'f64' ? new Float64Array(net.edgeCap) : new Int32Array(net.edgeCap);
  net.orderDirty = true; // same as after growth: the tree order is recomputed from the (persistent) parent/child links
}

export function cloneDeep<T>(root: T, shared: ReadonlySet<unknown> = new Set(), skip?: (owner: object, key: string) => boolean): Cloned<T> {
  const memo = new Map<object, object>();
  let bytes = 0;
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (shared.has(v)) return v;
    const seen = memo.get(v as object);
    if (seen) return seen;
    if (ArrayBuffer.isView(v)) {
      const c = (v as unknown as { slice(): ArrayBufferView }).slice();
      bytes += (v as ArrayBufferView).byteLength;
      memo.set(v, c);
      return c;
    }
    if (Array.isArray(v)) {
      const n = v.length;
      const out: unknown[] = new Array(n);
      memo.set(v, out);
      bytes += 16 + n * 8;
      for (let i = 0; i < n; i++) {
        const e = v[i];
        out[i] = e !== null && typeof e === 'object' ? walk(e) : e;
      }
      return out;
    }
    if (v instanceof Map) {
      const out = new Map<unknown, unknown>();
      memo.set(v, out);
      bytes += 48 + v.size * 40;
      for (const [k, e] of v) out.set(walk(k), walk(e));
      return out;
    }
    if (v instanceof Set) {
      const out = new Set<unknown>();
      memo.set(v, out);
      bytes += 48 + v.size * 24;
      for (const e of v) out.add(walk(e));
      return out;
    }
    const src = v as Record<string, unknown>;
    const out = Object.create(Object.getPrototypeOf(v)) as Record<string, unknown>;
    memo.set(v, out);
    bytes += 24;
    for (const k of Object.keys(src)) {
      if (skip && skip(src, k)) continue;
      const e = src[k];
      bytes += 8;
      out[k] = e !== null && typeof e === 'object' ? walk(e) : e;
    }
    return out;
  };
  return { value: walk(root) as T, bytes };
}

/**
 * Deep copy of a simulation (commits and schedule are shared, not copied). `scratch: 'omit'` leaves the solver scratch out (the copy is a
 * stored snapshot, not runnable until `reviveScratch`); `'keep'` copies everything (a plain runnable clone).
 */
export function cloneSimulation(sim: Simulation, scratch: 'keep' | 'omit' = 'keep'): Cloned<Simulation> {
  const shared = new Set<unknown>();
  for (const k of SHARED_KEYS) shared.add((sim as unknown as Record<string, unknown>)[k]);
  return cloneDeep(sim, shared, scratch === 'omit' ? (owner, key) => owner instanceof Network && NET_SCRATCH.has(key) : undefined);
}

export interface Checkpoint {
  tick: number;
  sim: Simulation;
  bytes: number;
}

export interface CheckpointOptions {
  /** Initial spacing in ticks. */
  interval: number;
  /** Total memory allowed for snapshots; when exceeded the capture rate halves and the least useful snapshots are dropped. */
  budgetBytes: number;
  /** Hard cap on the number of snapshots regardless of size. */
  maxCount: number;
  /** The interval is raised to `costFactor x captureMs / stepMs` ticks (capture overhead <= 1/costFactor of the compute it covers). 0 = fixed interval. */
  costFactor: number;
}

export const DEFAULT_CHECKPOINTS: CheckpointOptions = {
  interval: 200,
  budgetBytes: 320 * 1024 * 1024,
  maxCount: 4000,
  costFactor: 20,
};

/**
 * Ordered snapshots of one simulation timeline. `maybeCapture` is called after every tick; it copies the sim once at least `interval`
 * ticks have passed since the last capture. The interval is the base spacing, raised when captures are expensive relative to stepping
 * (capture cost <= ~5 % of the compute it covers). When the store goes over its memory budget, `thin` drops the least useful snapshots.
 */
export class CheckpointStore {
  readonly list: Checkpoint[] = [];
  interval: number;
  totalBytes = 0;
  captures = 0;
  lastCaptureMs = 0;
  private lastTick = 0;
  private opts: CheckpointOptions;

  constructor(opts: Partial<CheckpointOptions> = {}) {
    this.opts = { ...DEFAULT_CHECKPOINTS, ...opts };
    this.interval = this.opts.interval;
  }

  clear(): void {
    this.list.length = 0;
    this.totalBytes = 0;
    this.lastTick = 0;
    this.interval = this.opts.interval;
  }

  /**
   * Capture if `sim.tick` is at least `interval` past the newest capture. Ticks at or before it (replays after a backward seek) are never
   * recaptured. `stepMs` (average cost of a tick) lets the interval grow when snapshots are expensive. Returns true if a snapshot was taken.
   */
  maybeCapture(sim: Simulation, stepMs = 0): boolean {
    const t = sim.tick;
    if (t - this.lastTick < this.interval) return false;
    const t0 = performance.now();
    const c = cloneSimulation(sim, 'omit');
    this.lastCaptureMs = performance.now() - t0;
    this.lastTick = t;
    this.list.push({ tick: t, sim: c.value, bytes: c.bytes });
    this.totalBytes += c.bytes;
    this.captures++;
    if (stepMs > 0 && this.opts.costFactor > 0) this.interval = Math.max(this.opts.interval, Math.ceil((this.opts.costFactor * this.lastCaptureMs) / stepMs));
    if (this.totalBytes > this.opts.budgetBytes || this.list.length > this.opts.maxCount) this.thin();
    return true;
  }

  /**
   * Over budget: drop snapshots until the store is at 80 % of its limits. The victim is always the snapshot whose removal leaves the
   * cheapest merged replay span (estimated as ticks x snapshot size, size standing in for step cost), so what remains is spaced by estimated
   * replay time: sparse where the mold is small and ticks are cheap, denser late. Tick 0 counts as an implicit snapshot; the newest is never
   * dropped.
   */
  private thin(): void {
    const L = this.list;
    while (L.length > 1 && (this.totalBytes > this.opts.budgetBytes * 0.8 || L.length > this.opts.maxCount * 0.8)) {
      let best = 0;
      let bestCost = Infinity;
      for (let j = 0; j < L.length - 1; j++) {
        const span = L[j + 1].tick - (j > 0 ? L[j - 1].tick : 0);
        const cost = span * L[j + 1].bytes;
        if (cost < bestCost) {
          bestCost = cost;
          best = j;
        }
      }
      this.totalBytes -= L[best].bytes;
      L.splice(best, 1);
    }
  }

  /** Latest checkpoint with tick <= `tick` (or undefined). */
  before(tick: number): Checkpoint | undefined {
    let lo = 0;
    let hi = this.list.length - 1;
    let best: Checkpoint | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid].tick <= tick) {
        best = this.list[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  }
}
