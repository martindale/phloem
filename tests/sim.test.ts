// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateStressCommits } from '../src/ingest/stress';
import { parseCommitEvents } from '../src/model/parse';
import { Simulation } from '../src/sim/engine';
import { FOOD_STRIDE, H, HEADER, SEG_STRIDE } from '../src/sim/frame';
import { E_ALIVE, E_LOOP, N_ALIVE } from '../src/sim/network';

const fixture = parseCommitEvents(JSON.parse(readFileSync(new URL('../fixtures/stemdeck-first10.json', import.meta.url), 'utf8')));

function run(sim: Simulation, ticks: number): Float32Array {
  for (let i = 0; i < ticks; i++) sim.step();
  const out = new Float32Array(sim.packCapacity());
  sim.pack(out);
  return out;
}

function hash(a: Float32Array): string {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
  return h.toString(16);
}

describe('Simulation', () => {
  it('is deterministic for the same input and seed', () => {
    const ticks = fixture.length * 45 + 120;
    const a = run(new Simulation(fixture, { seed: 42 }), ticks);
    const b = run(new Simulation(fixture, { seed: 42 }), ticks);
    expect(a.length).toBe(b.length);
    expect(hash(a)).toBe(hash(b));
    const c = run(new Simulation(fixture, { seed: 43 }), ticks);
    expect(hash(c)).not.toBe(hash(a));
  });

  it('is deterministic across a memory compaction on a larger history', () => {
    const commits = generateStressCommits({ files: 600, commits: 30, seed: 3 });
    const opts = { seed: 5, ticksPerCommit: 12, compactMinNodes: 200 };
    const sa = new Simulation(commits, opts);
    const a = run(sa, 600);
    const b = run(new Simulation(commits, opts), 600);
    expect(sa.compactions).toBeGreaterThan(0);
    expect(hash(a)).toBe(hash(b));
  });

  it('applies commits on the fixed tick schedule and reaches every live file', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    run(sim, 1);
    expect(sim.commitIndex).toBe(0);
    const out = run(sim, fixture.length * 45 + 400);
    expect(sim.commitIndex).toBe(fixture.length - 1);
    expect(out[H.liveFiles]).toBe(sim.tree.liveFileCount);
    expect(out[H.growthTips]).toBe(0); // all growth finished
    // food entries = inoculum + live files (no deletes in this fixture)
    expect(out[H.food]).toBe(1 + sim.tree.liveFileCount);
  });

  it('keeps the vein network connected (every live node has a parent chain to the root)', () => {
    const commits = generateStressCommits({ files: 300, commits: 20, seed: 9 });
    const sim = new Simulation(commits, { seed: 2, ticksPerCommit: 15 });
    run(sim, 500);
    const net = sim.net;
    for (let i = 0; i < net.nodeTop; i++) {
      if (!(net.nflags[i] & N_ALIVE)) continue;
      let v = i;
      let hops = 0;
      while (v !== net.root && v >= 0 && hops < 1e5) {
        v = net.parent[v];
        hops++;
      }
      expect(v).toBe(net.root);
    }
    // loops only connect live nodes
    for (let e = 0; e < net.edgeTop; e++) {
      if (!(net.eflags[e] & E_ALIVE) || !(net.eflags[e] & E_LOOP)) continue;
      expect(net.nflags[net.ea[e]] & N_ALIVE).toBeTruthy();
      expect(net.nflags[net.eb[e]] & N_ALIVE).toBeTruthy();
    }
  });

  it('satisfies Kirchhoff flow balance on tree-only networks (Tero flux)', () => {
    const sim = new Simulation(fixture, { seed: 1, network: { fuseProbGrowth: 0, fuseProbExplorer: 0 } });
    run(sim, 300);
    const net = sim.net;
    const imbalance = new Float64Array(net.nodeTop);
    for (let e = 0; e < net.edgeTop; e++) {
      if (!(net.eflags[e] & E_ALIVE)) continue;
      imbalance[net.ea[e]] += net.eQ[e];
      imbalance[net.eb[e]] -= net.eQ[e];
    }
    for (const t of net.tips) if (t.active && !t.explorer) imbalance[t.node] += net.p.tipDemand;
    let worst = 0;
    for (let i = 0; i < net.nodeTop; i++) {
      if (!(net.nflags[i] & N_ALIVE) || i === net.root) continue;
      worst = Math.max(worst, Math.abs(imbalance[i] + net.demand[i]));
    }
    expect(worst).toBeLessThan(1e-4 * Math.max(1, net.totalDemand));
  });

  it('withers deleted files and moves renamed food', () => {
    const c = (files: CommitFiles) => ({ hash: 'h', author: 'a', email: '', date: '', message: '', files });
    type CommitFiles = { path: string; status: 'A' | 'M' | 'D' | 'R'; added: number; removed: number; old_path?: string }[];
    const commits = [
      c([
        { path: 'a/keep.ts', status: 'A', added: 5, removed: 0 },
        { path: 'a/doomed.ts', status: 'A', added: 5, removed: 0 },
        { path: 'a/moving.ts', status: 'A', added: 5, removed: 0 },
      ]),
      c([
        { path: 'a/doomed.ts', status: 'D', added: 0, removed: 5 },
        { path: 'b/moved.ts', old_path: 'a/moving.ts', status: 'R', added: 0, removed: 0 },
      ]),
    ];
    const sim = new Simulation(commits, { seed: 1, ticksPerCommit: 200 });
    run(sim, 199);
    const edgesBefore = sim.net.edgeCount;
    const out = run(sim, 900);
    expect(sim.tree.liveFileCount).toBe(2);
    // the deleted file's food has faded out of the frame
    expect(out[H.food]).toBe(1 + 2);
    const moved = sim.tree.lookup('b/moved.ts');
    expect(moved).toBeGreaterThan(0);
    expect(edgesBefore).toBeGreaterThan(0);
    // the moved food sits at its new site and has been engulfed by a new vein
    const lx = sim.layout.x[moved];
    const ly = sim.layout.y[moved];
    const lz = sim.layout.z[moved];
    const fo = HEADER + out[H.segs] * SEG_STRIDE;
    let found = false;
    for (let k = 0; k < out[H.food]; k++) {
      const o = fo + k * FOOD_STRIDE;
      // food: x y z radius | nutrient engulf fade seedKind
      if (Math.hypot(out[o] - lx, out[o + 1] - ly, out[o + 2] - lz) < 0.5 && out[o + 5] > 0.9) found = true;
    }
    expect(found).toBe(true);
  });
});
