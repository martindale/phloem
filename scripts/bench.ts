// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Headless sim benchmark (Node, no GPU): `npm run bench -- [files] [commits]`
 * Reports per-tick sim cost, which is what the worker pays per frame.
 */
import { readFileSync } from 'node:fs';
import { parseCommitEvents } from '../src/model/parse';
import { generateStressCommits } from '../src/ingest/stress';
import { Simulation } from '../src/sim/engine';
import { H } from '../src/sim/frame';

function run(label: string, sim: Simulation, ticks: number): void {
  let buf = new Float32Array(1 << 16);
  const t0 = performance.now();
  let stepMs = 0;
  let packMs = 0;
  const window: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const a = performance.now();
    sim.step();
    const b = performance.now();
    stepMs += b - a;
    window.push(b - a);
    if (i % 4 === 0) {
      const need = sim.packCapacity();
      if (buf.length < need) buf = new Float32Array(need * 1.5);
      const c = performance.now();
      sim.pack(buf);
      packMs += performance.now() - c;
    }
  }
  sim.pack(buf);
  const last = window.slice(-200);
  const avgLast = last.reduce((s, v) => s + v, 0) / last.length;
  console.log(
    `${label}: ${ticks} ticks in ${(performance.now() - t0).toFixed(0)}ms | avg step ${(stepMs / ticks).toFixed(3)}ms | last-200 step ${avgLast.toFixed(3)}ms | pack ${(packMs / (ticks / 4)).toFixed(3)}ms | segs ${buf[H.segs]} nodes ${buf[H.nodes]} food ${buf[H.food]} files ${buf[H.liveFiles]} tips ${buf[H.growthTips]} expl ${buf[H.explorers]} cg ${buf[H.cgIters]}`,
  );
}

const files = Number(process.argv[2] ?? 5000);
const commits = Number(process.argv[3] ?? 120);
const fixture = parseCommitEvents(JSON.parse(readFileSync('fixtures/stemdeck-first10.json', 'utf8')));
const fs = new Simulation(fixture, { seed: 1 });
run('fixture', fs, fs.totalTicks + 200);
const stress = generateStressCommits({ files, commits });
const ss = new Simulation(stress, { seed: 1, ticksPerCommit: 20 });
run(`stress ${files} files/${commits} commits`, ss, ss.totalTicks + 300);
