// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCommitEvents } from '../src/model/parse';
import { NodeKind } from '../src/model/tree';
import { Simulation } from '../src/sim/engine';
import { ANCHOR_STRIDE, H, SEG_R_MAX, anchorOffset, readSegment } from '../src/sim/frame';
import { N_ALIVE } from '../src/sim/network';
import { SpatialHash } from '../src/sim/spatial';
import { coneDir } from '../src/sim/vec';

const fixture = parseCommitEvents(JSON.parse(readFileSync(new URL('../fixtures/stemdeck-first10.json', import.meta.url), 'utf8')));

function run(sim: Simulation, ticks: number): Float32Array {
  for (let i = 0; i < ticks; i++) sim.step();
  const out = new Float32Array(sim.packCapacity());
  sim.pack(out);
  return out;
}

describe('SpatialHash (3D)', () => {
  it('returns nothing (and does not throw) for empty hashes and empty / never-touched cells', () => {
    const h = new SpatialHash(5, 8, 4);
    const out = new Int32Array(16);
    expect(h.query(0, 0, 0, 50, out)).toBe(0);
    expect(h.query(-1e4, 3e4, -7e3, 12, out)).toBe(0);
    h.insert(3, 100, 100, 100);
    // a region far from the only item (hash collisions may add candidates, but here the table is sparse)
    const n = h.query(-100, -100, -100, 4, out);
    for (let k = 0; k < n; k++) expect(out[k]).toBe(3);
  });

  it('finds items by 3D position, tracks moves and removals, and grows its capacity', () => {
    const h = new SpatialHash(4, 10, 2);
    const out = new Int32Array(64);
    const has = (x: number, y: number, z: number, r: number, id: number) => {
      const n = h.query(x, y, z, r, out);
      for (let k = 0; k < n; k++) if (out[k] === id) return true;
      return false;
    };
    h.insert(0, 0, 0, 0);
    h.insert(1, 0, 0, 40); // same x-y, different depth
    h.insert(9, -3.5, 2, -1); // beyond the initial capacity
    expect(has(0, 0, 0, 2, 0)).toBe(true);
    expect(has(0, 0, 40, 2, 1)).toBe(true);
    expect(has(-3, 2, -1, 1, 9)).toBe(true);
    // depth separates items with the same x-y
    const n = h.query(0, 0, 0, 2, out);
    for (let k = 0; k < n; k++) expect(out[k]).not.toBe(1);
    h.insert(1, 10, 10, 10); // move
    expect(has(0, 0, 40, 2, 1)).toBe(false);
    expect(has(10, 10, 10, 1, 1)).toBe(true);
    h.remove(1);
    h.remove(1); // idempotent
    h.remove(1234); // unknown id
    expect(has(10, 10, 10, 1, 1)).toBe(false);
    h.clear();
    expect(h.query(0, 0, 0, 10, out)).toBe(0);
  });

  it('never writes past the output buffer', () => {
    const h = new SpatialHash(1, 8, 64);
    for (let i = 0; i < 50; i++) h.insert(i, 0.5, 0.5, 0.5);
    const out = new Int32Array(8);
    expect(h.query(0.5, 0.5, 0.5, 0.1, out)).toBe(8);
  });
});

describe('coneDir', () => {
  it('returns unit vectors at the requested angle from the axis', () => {
    const d = new Float64Array(3);
    const axes = [
      [1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0.6, -0.48, 0.64],
    ];
    for (const [bx, by, bz] of axes) {
      for (const theta of [0, 0.3, 1.2, 2.5]) {
        for (const phi of [0, 1, 4]) {
          coneDir(bx, by, bz, theta, phi, d);
          expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 9);
          expect(d[0] * bx + d[1] * by + d[2] * bz).toBeCloseTo(Math.cos(theta), 9);
        }
      }
    }
  });
});

describe('3D growth', () => {
  it('grows a volumetric but oblate network (not a flat sheet, not an isotropic ball)', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    run(sim, fixture.length * 45 + 300);
    const net = sim.net;
    let n = 0;
    const s = [0, 0, 0];
    const ss = [0, 0, 0];
    for (let i = 0; i < net.nodeTop; i++) {
      if (!(net.nflags[i] & N_ALIVE)) continue;
      n++;
      const p = [net.x[i], net.y[i], net.z[i]];
      for (let a = 0; a < 3; a++) {
        s[a] += p[a];
        ss[a] += p[a] * p[a];
      }
    }
    const sd = s.map((v, a) => Math.sqrt(ss[a] / n - (v / n) ** 2));
    const xy = Math.max(sd[0], sd[1]);
    expect(sd[2]).toBeGreaterThan(0.2 * xy);
    expect(sd[2]).toBeLessThan(0.9 * xy);
  });

  it('lands every reached file on its 3D layout site and packs 3D segments', () => {
    const sim = new Simulation(fixture, { seed: 4 });
    const out = run(sim, fixture.length * 45 + 400);
    // anchors: id x y z reached
    const ao = anchorOffset(out);
    let files = 0;
    for (let k = 0; k < out[H.anchors]; k++) {
      const o = ao + k * ANCHOR_STRIDE;
      const id = out[o];
      if (sim.tree.get(id).kind !== NodeKind.File) continue;
      files++;
      expect(out[o + 4]).toBe(1);
      expect(out[o + 1]).toBeCloseTo(sim.layout.x[id], 3);
      expect(out[o + 2]).toBeCloseTo(sim.layout.y[id], 3);
      expect(out[o + 3]).toBeCloseTo(sim.layout.z[id], 3);
    }
    expect(files).toBe(sim.tree.liveFileCount);
    // every segment decodes to finite 3D endpoints inside the header bbox, with sane radii
    let zSpan = 0;
    for (let k = 0; k < out[H.segs]; k++) {
      const g = readSegment(out, k);
      for (const [v, lo, hi] of [
        [g.x0, H.minX, H.maxX],
        [g.y1, H.minY, H.maxY],
        [g.z0, H.minZ, H.maxZ],
        [g.z1, H.minZ, H.maxZ],
      ] as const) {
        expect(v).toBeGreaterThanOrEqual(out[lo] - 1e-3);
        expect(v).toBeLessThanOrEqual(out[hi] + 1e-3);
      }
      expect(g.r0).toBeGreaterThan(0);
      expect(g.r0).toBeLessThan(SEG_R_MAX);
      expect(g.r1).toBeGreaterThan(0);
      expect(g.alpha).toBeGreaterThan(0);
      expect(g.phase).toBeGreaterThanOrEqual(0);
      expect(g.phase).toBeLessThanOrEqual(1);
      zSpan = Math.max(zSpan, Math.abs(g.z0), Math.abs(g.z1));
    }
    expect(zSpan).toBeGreaterThan(10);
  });

  it('quantizes segment radii to within SEG_R_MAX / 65535', () => {
    const sim = new Simulation(fixture, { seed: 2 });
    const out = run(sim, 200);
    const net = sim.net;
    // the first packed segment is the first alive edge; its radius r >= eR (tapered joints only grow it)
    let e = 0;
    while (!(net.eflags[e] & 1)) e++;
    const g = readSegment(out, 0);
    expect(g.r0 + 1e-3).toBeGreaterThanOrEqual(Math.min(net.eR[e], SEG_R_MAX));
    expect(Math.abs(Math.round((g.r0 / SEG_R_MAX) * 65535) - (g.r0 / SEG_R_MAX) * 65535)).toBeLessThan(1e-3);
  });
});

describe('full stemdeck history (regression: 3D spatial queries over the whole playback)', () => {
  it('plays all commits and the settling period without errors, keeping frames finite', () => {
    const full = parseCommitEvents(JSON.parse(readFileSync(new URL('../fixtures/stemdeck-full.json', import.meta.url), 'utf8')));
    const sim = new Simulation(full, { seed: 1 });
    const end = sim.totalTicks + 300;
    let out = new Float32Array(1024);
    for (let t = 0; t < end; t++) {
      sim.step();
      if (t % 97 === 0 || t === end - 1) {
        const need = sim.packCapacity();
        if (out.length < need) out = new Float32Array(need * 1.5);
        sim.pack(out);
        for (const k of [H.minX, H.minY, H.minZ, H.maxX, H.maxY, H.maxZ]) expect(Number.isFinite(out[k])).toBe(true);
      }
    }
    expect(sim.commitIndex).toBe(full.length - 1);
    expect(out[H.growthTips]).toBe(0);
    const net = sim.net;
    for (let i = 0; i < net.nodeTop; i++) {
      if (!(net.nflags[i] & N_ALIVE)) continue;
      expect(Number.isFinite(net.x[i] + net.y[i] + net.z[i])).toBe(true);
    }
  }, 60000);
});
