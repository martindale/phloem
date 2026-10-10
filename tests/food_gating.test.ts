// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommitEvent } from '../src/model/events';
import { parseCommitEvents } from '../src/model/parse';
import { Simulation } from '../src/sim/engine';
import { A, ANCHOR_STRIDE, FOOD_STRIDE, H, SEG_STRIDE, anchorOffset, foodOffset } from '../src/sim/frame';
import { cloneSimulation, reviveScratch } from '../src/sim/snapshot';

/**
 * A file's food dot (oat flake) is not in the frame until the mold has reached it, and the frame's bounding box
 * (which the camera fit, the director's establishing shot and the motes' scene box read) ignores unreached files.
 */

const ev = (files: CommitEvent['files'], n = 0): CommitEvent => ({ hash: String(n).padStart(40, '0'), author: 'a', email: '', date: '', message: '', files });
const add = (path: string): CommitEvent['files'][number] => ({ path, status: 'A', added: 3, removed: 0 });

function bigCommit(files: number): CommitEvent {
  const fs: CommitEvent['files'] = [];
  for (let i = 0; i < files; i++) fs.push(add(`pkg${i % 23}/mod${(i >> 3) % 17}/f${i}.ts`));
  return ev(fs);
}

function pack(sim: Simulation): Float32Array {
  const out = new Float32Array(sim.packCapacity());
  sim.pack(out);
  return out;
}
function run(sim: Simulation, to: number): Float32Array {
  while (sim.tick < to) sim.step();
  return pack(sim);
}
function foodRecords(f: Float32Array): number[][] {
  const o = foodOffset(f);
  const r: number[][] = [];
  for (let k = 0; k < f[H.food]; k++) r.push(Array.from(f.subarray(o + k * FOOD_STRIDE, o + (k + 1) * FOOD_STRIDE)));
  return r;
}
function anchors(f: Float32Array): { id: number; x: number; y: number; z: number; reached: boolean }[] {
  const o = anchorOffset(f);
  const r = [];
  for (let i = 0; i < (f[H.anchors] | 0); i++) {
    const a = o + i * ANCHOR_STRIDE;
    r.push({ id: f[a + A.id], x: f[a + A.x], y: f[a + A.y], z: f[a + A.z], reached: f[a + A.reached] > 0.5 });
  }
  return r;
}
/** Bounding box of the vein geometry in a frame (segments incl. ghosts). */
function segBox(f: Float32Array): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < f[H.segs]; i++) {
    const o = 56 + i * SEG_STRIDE;
    for (let e = 0; e < 2; e++) {
      for (let c = 0; c < 3; c++) {
        const v = f[o + e * 3 + c];
        if (v < b[c]) b[c] = v;
        if (v > b[3 + c]) b[3 + c] = v;
      }
    }
  }
  return b;
}
const bits = (f: Float32Array): string => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');

describe('food gating (unreached files are invisible)', { timeout: 120_000 }, () => {
  it('a first commit with thousands of files shows no food at all at tick 0, then grows one dot per reached file', () => {
    const sim = new Simulation([bigCommit(1200)], { seed: 3, ticksPerCommit: 45 });
    const f0 = run(sim, 1);
    expect(f0[H.liveFiles]).toBeGreaterThan(0); // the files exist in the tree...
    expect(anchors(f0).filter((a) => !a.reached).length).toBeGreaterThan(300); // ...and are not reached yet
    expect(f0[H.food]).toBe(1); // inoculum only
    let prev = 1;
    let sawPartial = false;
    for (const t of [30, 90, 200, 500, 1400, 2200]) {
      const f = run(sim, t);
      const reachedFiles = anchors(f).filter((a) => a.reached).length; // folders included
      const food = f[H.food] - 1;
      expect(food).toBeLessThanOrEqual(reachedFiles);
      expect(f[H.food]).toBeGreaterThanOrEqual(prev); // no files are removed here: the set only grows
      prev = f[H.food];
      if (food > 0 && food < f[H.liveFiles]) sawPartial = true;
    }
    expect(sawPartial).toBe(true);
    const done = run(sim, 3200);
    expect(done[H.food] - 1).toBe(done[H.liveFiles]); // everything reached by then
  });

  it('every food record sits at a reached file, and unreached files never appear', () => {
    const sim = new Simulation([bigCommit(300), ev([add('late/a.ts'), add('late/b/c.ts')], 1)], { seed: 9, ticksPerCommit: 60 });
    for (const t of [5, 40, 80, 130, 200, 300, 600]) {
      const f = run(sim, t);
      const unreached = anchors(f).filter((a) => !a.reached);
      for (const r of foodRecords(f).slice(1)) {
        for (const a of unreached) expect(Math.hypot(r[0] - a.x, r[1] - a.y, r[2] - a.z)).toBeGreaterThan(1e-3);
      }
    }
  });

  it('the bounding box covers veins only: it neither reserves space for nor jumps to unreached food', () => {
    const sim = new Simulation([bigCommit(1500)], { seed: 4, ticksPerCommit: 45 });
    for (const t of [1, 20, 60, 150]) {
      const f = run(sim, t);
      const box = segBox(f);
      const hb = [f[H.minX], f[H.minY], f[H.minZ], f[H.maxX], f[H.maxY], f[H.maxZ]];
      for (let c = 0; c < 6; c++) expect(hb[c]).toBeCloseTo(box[c], 4);
      // the layout of the unreached files is much wider than what has grown
      const un = anchors(f).filter((a) => !a.reached);
      const ux = Math.max(...un.map((a) => a.x)) - Math.min(...un.map((a) => a.x));
      if (t <= 20) expect(hb[3] - hb[0]).toBeLessThan(ux * 0.7);
    }
  });

  it('frames are deterministic, and a restored checkpoint gives the same visible set as sequential play', () => {
    const commits = [bigCommit(400), ev([add('x/y/z.ts')], 1), ev([{ path: 'pkg1', status: 'D', added: 0, removed: 1 }], 2)];
    const opts = { seed: 6, ticksPerCommit: 70, compactMinNodes: 150 };
    const a = new Simulation(commits, opts);
    const b = new Simulation(commits, opts);
    const seq = new Map<number, string>();
    let snap: Simulation | null = null;
    for (const t of [3, 50, 120, 240, 500]) {
      const fa = run(a, t);
      const fb = run(b, t);
      expect(bits(fa)).toBe(bits(fb));
      seq.set(t, bits(fa));
      if (t === 120) snap = cloneSimulation(a).value;
    }
    const c = snap!;
    reviveScratch(c);
    for (const t of [240, 500]) expect(bits(run(c, t))).toBe(seq.get(t));
  });

  it('a deleted file that was never reached is never drawn; a reached one fades out; a renamed-away one disappears', () => {
    const commits = [
      ev([add('a/keep.ts'), add('a/doomed.ts'), add('a/moving.ts')], 0),
      ev([{ path: 'a/doomed.ts', status: 'D', added: 0, removed: 3 }, { path: 'b/moved.ts', old_path: 'a/moving.ts', status: 'R', added: 0, removed: 0 }, add('c/never.ts'), { path: 'c/never.ts', status: 'D', added: 0, removed: 3 }], 1),
    ];
    const sim = new Simulation(commits, { seed: 1, ticksPerCommit: 200 });
    run(sim, 199);
    expect(run(sim, 199)[H.food]).toBeGreaterThan(1); // the first three were reached (v. long settle)
    const reachedBefore = run(sim, 199)[H.food];
    expect(reachedBefore).toBe(4);
    const moving = sim.tree.lookup('a/moving.ts');
    expect(moving).toBeGreaterThan(0);
    // right after the commit that renames and deletes, nothing of moving / doomed / the new files is waiting as a dot
    const f = run(sim, 201);
    const a = anchors(f);
    const unreached = a.filter((x) => !x.reached && x.id > 0);
    for (const r of foodRecords(f).slice(1)) for (const u of unreached) expect(Math.hypot(r[0] - u.x, r[1] - u.y, r[2] - u.z)).toBeGreaterThan(1e-3);
    expect(f[H.food]).toBeLessThanOrEqual(1 + 2 /* keep + the fading doomed */);
    // never.ts is added and deleted in the same commit, before any vein could reach it: it contributes nothing, ever
    let maxFood = 0;
    for (let t = 202; t < 900; t += 7) maxFood = Math.max(maxFood, run(sim, t)[H.food]);
    expect(maxFood).toBeLessThanOrEqual(1 + 3); // keep, moved (re-arrived) and at most the fading doomed
    expect(run(sim, 1800)[H.food]).toBe(1 + 2);
  });

  it('a newly reached food announces itself: it grows in and glows briefly, then settles', () => {
    const sim = new Simulation([ev([add('d/one.ts')])], { seed: 2, ticksPerCommit: 100 });
    let first = -1;
    const radius: number[] = [];
    const glow: number[] = [];
    for (let t = 1; t < 700; t++) {
      const f = run(sim, t);
      if (f[H.food] > 1) {
        if (first < 0) first = t;
        const r = foodRecords(f)[1];
        radius.push(r[3]);
        glow.push(r[4]);
        if (t - first > 80) break;
      }
    }
    expect(first).toBeGreaterThan(0);
    expect(radius.length).toBeGreaterThan(60);
    expect(glow[0]).toBeGreaterThan(glow[glow.length - 1] + 0.8); // flare, then back to the resting glow
    expect(radius[0]).toBeGreaterThan(radius[radius.length - 1]);
  });

  it('the real netbattle first commit (718 files) draws nothing until veins arrive', () => {
    const commits = parseCommitEvents(JSON.parse(readFileSync(new URL('../public/featured/thcp__netbattle.json', import.meta.url), 'utf8')));
    expect(commits[0].files.length).toBeGreaterThan(500);
    const sim = new Simulation(commits, { seed: 1 });
    const f = run(sim, 1);
    expect(f[H.food]).toBe(1);
    const later = run(sim, 120);
    expect(later[H.food] - 1).toBeLessThan(later[H.liveFiles] / 2);
  });
});
