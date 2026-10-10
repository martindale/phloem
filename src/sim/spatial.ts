// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Allocation-free 3D spatial hash for point items identified by small integers.
 * Buckets are a fixed-size hash table of doubly-linked lists stored in typed
 * arrays. Queries return candidate ids (callers do the exact distance test;
 * hash collisions can only add extra candidates, never lose any).
 *
 * Query cost grows with (2r / cell)^3 cells, so keep r within a few cells; use
 * a second, coarser hash for long-range nearest searches (see Network.coarse).
 */
export class SpatialHash {
  private head: Int32Array;
  private next: Int32Array;
  private prev: Int32Array;
  private bucketOf: Int32Array;
  private readonly mask: number;
  private readonly inv: number;

  constructor(readonly cell: number, bucketsLog2 = 16, capacity = 1024) {
    this.head = new Int32Array(1 << bucketsLog2).fill(-1);
    this.mask = (1 << bucketsLog2) - 1;
    this.inv = 1 / cell;
    this.next = new Int32Array(capacity).fill(-1);
    this.prev = new Int32Array(capacity).fill(-1);
    this.bucketOf = new Int32Array(capacity).fill(-1);
  }

  private bucket(cx: number, cy: number, cz: number): number {
    return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) & this.mask;
  }

  private ensure(id: number): void {
    if (id < this.next.length) return;
    let cap = this.next.length;
    while (cap <= id) cap *= 2;
    const grow = (a: Int32Array) => {
      const b = new Int32Array(cap).fill(-1);
      b.set(a);
      return b;
    };
    this.next = grow(this.next);
    this.prev = grow(this.prev);
    this.bucketOf = grow(this.bucketOf);
  }

  insert(id: number, x: number, y: number, z: number): void {
    this.ensure(id);
    const inv = this.inv;
    const b = this.bucket(Math.floor(x * inv), Math.floor(y * inv), Math.floor(z * inv));
    if (this.bucketOf[id] === b) return; // still in the same cell
    if (this.bucketOf[id] >= 0) this.remove(id);
    const h = this.head[b];
    this.next[id] = h;
    this.prev[id] = -1;
    if (h >= 0) this.prev[h] = id;
    this.head[b] = id;
    this.bucketOf[id] = b;
  }

  remove(id: number): void {
    if (id >= this.bucketOf.length) return;
    const b = this.bucketOf[id];
    if (b < 0) return;
    const p = this.prev[id];
    const n = this.next[id];
    if (p >= 0) this.next[p] = n;
    else this.head[b] = n;
    if (n >= 0) this.prev[n] = p;
    this.bucketOf[id] = -1;
    this.next[id] = -1;
    this.prev[id] = -1;
  }

  clear(): void {
    this.head.fill(-1);
    this.next.fill(-1);
    this.prev.fill(-1);
    this.bucketOf.fill(-1);
  }

  /** Write candidate ids within the cells overlapping the radius into `out`. Returns count. */
  query(x: number, y: number, z: number, r: number, out: Int32Array): number {
    const inv = this.inv;
    const x0 = Math.floor((x - r) * inv);
    const x1 = Math.floor((x + r) * inv);
    const y0 = Math.floor((y - r) * inv);
    const y1 = Math.floor((y + r) * inv);
    const z0 = Math.floor((z - r) * inv);
    const z1 = Math.floor((z + r) * inv);
    const cap = out.length;
    let n = 0;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          for (let id = this.head[this.bucket(cx, cy, cz)]; id >= 0; id = this.next[id]) {
            if (n < cap) out[n++] = id;
          }
        }
      }
    }
    return n;
  }
}
