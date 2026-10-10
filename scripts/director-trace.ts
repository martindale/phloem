// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Offline auto-director trace (Node, no GPU): runs the real sim at 60 frames/s of playback and the real Camera + Director on its
 * frame headers, so the camera path can be tuned and inspected without a browser (software GL is far too slow to play in real time).
 *
 *   npm run director-trace -- [startCommit=316] [seconds=14] [speed=1] [out.json]
 *
 * Prints one row every 0.5 s; with an output path, writes every frame { t, tick, commit, pose, hot, ... } as JSON
 * (tests/e2e/director_check.py `frames` replays chosen frames in the real renderer).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCommitEvents } from '../src/model/parse';
import { Camera } from '../src/render/camera';
import { Director, createSignals, readSignals } from '../src/render/director';
import { Simulation } from '../src/sim/engine';
import { H, HEADER } from '../src/sim/frame';

const startCommit = Number(process.argv[2] ?? 316);
const seconds = Number(process.argv[3] ?? 14);
const speed = Number(process.argv[4] ?? 1);
const out = process.argv[5];
const VW = 1280;
const VH = 800;
const FPS = 60;

const commits = parseCommitEvents(JSON.parse(readFileSync('fixtures/stemdeck-full.json', 'utf8')));
const sim = new Simulation(commits, { seed: 1 });
const buf = new Float32Array(sim.packCapacity() * 1.5 + 1024);
const startTick = sim.sched[startCommit] ?? startCommit * 45;
// a seek lands on the settled state of the commit; stepping to its landing tick plus the apply time is close enough for a trace
while (sim.tick < startTick) sim.step();
sim.pack(buf);

const cam = new Camera();
cam.bottomInset = 132;
const dir = new Director();
dir.setEnabled(true);
const sig = createSignals();
cam.auto = false;
// first frame: snap to the establishing shot like main.ts does, then let the director take it from there
const header = new Float32Array(HEADER);
function frame(dt: number): void {
  header.set(buf.subarray(0, HEADER));
  header[H.playing] = 1;
  cam.follow(header[H.minX], header[H.minY], header[H.minZ], header[H.maxX], header[H.maxY], header[H.maxZ], VW, VH, dt);
  dir.step(dt, readSignals(header, sig), cam, cam.fitDist);
  cam.update(VW, VH, dt);
}
cam.auto = true;
frame(1);
cam.snap();
cam.auto = false;

const rows: unknown[] = [];
// label-readability probe: fixed world points spread over the mold; how fast do they cross the screen and how smooth is it?
const probes: Array<[number, number, number]> = [];
for (const fx of [-0.6, 0, 0.6]) for (const fy of [-0.5, 0.5]) probes.push([header[H.minX] * (1 - fx) / 2 + header[H.maxX] * (1 + fx) / 2, (header[H.minY] + header[H.maxY]) / 2 + fy * (header[H.maxY] - header[H.minY]) / 2, (header[H.minZ] + header[H.maxZ]) / 2]);
const prev = probes.map(() => [0, 0, 0, 0]); // x, y, vx, vy
let maxSpeed = 0;
let maxAccel = 0;
const scr = new Float32Array(4);

const dt = 1 / FPS;
let tickAcc = 0;
for (let i = 0; i < seconds * FPS; i++) {
  tickAcc += 60 * speed * dt;
  while (tickAcc >= 1) {
    sim.step();
    tickAcc -= 1;
  }
  sim.pack(buf);
  frame(dt);
  const t = (i + 1) * dt;
  probes.forEach((q, k) => {
    if (!cam.project(q[0], q[1], q[2], scr)) return;
    const pr = prev[k];
    const vx = (scr[0] - pr[0]) / dt;
    const vy = (scr[1] - pr[1]) / dt;
    if (i > 1) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(vx, vy));
      maxAccel = Math.max(maxAccel, Math.hypot(vx - pr[2], vy - pr[3]) / dt);
    }
    pr[0] = scr[0]; pr[1] = scr[1]; pr[2] = vx; pr[3] = vy;
  });
  rows.push({
    t, tick: header[H.tick], commit: header[H.commit], dist: cam.dist, fit: cam.fitDist, tx: cam.tx, ty: cam.ty, tz: cam.tz, yaw: cam.yaw, pitch: cam.pitch,
    act: header[H.activity], hotW: header[H.hotW], hotR: header[H.hotR], hot: [header[H.hotX], header[H.hotY], header[H.hotZ]],
    follow: dir.follow, burst: dir.burst, calm: dir.calm, dact: dir.act, auth: dir.authority,
    bbox: [header[H.minX], header[H.minY], header[H.minZ], header[H.maxX], header[H.maxY], header[H.maxZ]],
  });
  if (i % (FPS / 2) === 0) {
    const r = rows[rows.length - 1] as Record<string, number & number[]>;
    console.log(
      `t=${t.toFixed(1).padStart(5)} tick=${String(r.tick).padStart(5)} c=${String(r.commit).padStart(3)} act=${r.act.toFixed(2)} hotW=${r.hotW.toFixed(0).padStart(3)} hotR=${r.hotR.toFixed(0).padStart(3)} ` +
        `follow=${r.follow.toFixed(2)} burst=${r.burst.toFixed(2)} calm=${r.calm.toFixed(2)} | dist=${r.dist.toFixed(0).padStart(4)} fit=${r.fit.toFixed(0).padStart(4)} ` +
        `tgt=(${r.tx.toFixed(0)},${r.ty.toFixed(0)},${r.tz.toFixed(0)}) hot=(${r.hot.map((v) => v.toFixed(0)).join(',')}) yaw=${r.yaw.toFixed(2)} pitch=${r.pitch.toFixed(2)}`,
    );
  }
}
console.log(`label probes (${probes.length} fixed world points, ${VW}x${VH}): max screen speed ${maxSpeed.toFixed(1)} px/s, max screen acceleration ${maxAccel.toFixed(1)} px/s^2`);
if (out) writeFileSync(out, JSON.stringify(rows));
