// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scale check for ingestion + worker protocol (Node, no GPU).
 *   npm run scale -- [files=15000] [commits=20000] [simCommits=400] [tpc=6]
 * 1. generate a synthetic history, serialise it as git log text, parse it with the real streaming ingest path (time + heap);
 * 2. drive the SimController: step cost while growing, checkpoint size/capture cost, backward/forward seek time, append while running.
 */
import { generateStressCommits } from '../src/ingest/stress';
import { ingestStream, textStream } from '../src/ingest/filestream';
import type { CommitEvent } from '../src/model/events';
import { SimController } from '../src/worker/controller';
import { toGitLog } from './synthetic-log';

const files = Number(process.argv[2] ?? 15000);
const nCommits = Number(process.argv[3] ?? 20000);
const simCommits = Number(process.argv[4] ?? 400);
const tpc = Number(process.argv[5] ?? 6);
const mb = (b: number) => (b / 1048576).toFixed(1);
const heap = () => {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
};

let t = performance.now();
const gen = generateStressCommits({ files, commits: nCommits, seed: 7 });
console.log(`generate ${nCommits} commits: ${(performance.now() - t).toFixed(0)} ms; total file changes ${gen.reduce((s, c) => s + c.files.length, 0)}`);
t = performance.now();
const text = toGitLog(gen);
console.log(`serialise: ${(performance.now() - t).toFixed(0)} ms, ${mb(text.length)} MB`);

const h0 = heap();
t = performance.now();
const commits: CommitEvent[] = [];
const res = await ingestStream(textStream(text), text.length, { onBatch: (b) => commits.push(...b) });
const parseMs = performance.now() - t;
console.log(`PARSE: ${res.commits} commits, ${parseMs.toFixed(0)} ms (${(text.length / 1e6 / (parseMs / 1000)).toFixed(0)} MB/s); heap +${mb(heap() - h0)} MB for the CommitEvent[]`);
if (JSON.stringify(commits.slice(-50)) !== JSON.stringify(gen.slice(-50).map((c) => ({ ...c, files: c.files.map((f) => ({ ...f })) })))) {
  // field order may differ; compare semantically
  const a = commits.slice(-50);
  const b = gen.slice(-50);
  let ok = a.length === b.length;
  for (let i = 0; ok && i < a.length; i++) ok = a[i].hash === b[i].hash && a[i].files.length === b[i].files.length && a[i].files.every((f, j) => f.path === b[i].files[j].path && f.status === b[i].files[j].status);
  console.log(`round-trip check: ${ok ? 'ok' : 'MISMATCH'}`);
}

// ---- simulation: stream the first simCommits commits in, like a fetch would
const msgs: unknown[] = [];
const ctl = new SimController((m) => msgs.push(m), () => {}, undefined, {});
const first = commits.slice(0, 50);
ctl.handle({ type: 'load', commits: first, options: { ticksPerCommit: tpc }, streaming: true });
let appended = 50;
const stepMs: number[] = [];
let capMs: number[] = [];
const tStart = performance.now();
while (ctl.sim!.commitIndex < simCommits - 1) {
  const a = performance.now();
  const n = ctl.runTicks(1, 1e9);
  const dt = performance.now() - a;
  if (n === 0 || ctl.sim!.tick >= ctl.sim!.horizon - 1) {
    const take = Math.min(100, simCommits - appended);
    if (take <= 0) break;
    ctl.handle({ type: 'append', commits: commits.slice(appended, appended + take) });
    appended += take;
  }
  stepMs.push(dt);
  if (ctl.checkpoints.lastCaptureMs) capMs.push(ctl.checkpoints.lastCaptureMs);
  if (stepMs.length % 500 === 0) {
    const w = stepMs.slice(-500);
    const s = ctl.sim!;
    console.log(
      `  tick ${s.tick} commit ${s.commitIndex} files ${s.tree.liveFileCount} nodes ${s.net.nodeCount} | step ${(w.reduce((x, y) => x + y, 0) / w.length).toFixed(2)} ms (max ${Math.max(...w).toFixed(0)}) | ckpt ${ctl.checkpoints.list.length} x ${mb(ctl.checkpoints.totalBytes / Math.max(1, ctl.checkpoints.list.length))} MB = ${mb(ctl.checkpoints.totalBytes)} MB, interval ${ctl.checkpoints.interval}, capture ${ctl.checkpoints.lastCaptureMs.toFixed(0)} ms`,
    );
  }
}
const s = ctl.sim!;
const sorted = stepMs.slice().sort((a, b) => a - b);
console.log(`SIM: ${s.tick} ticks in ${((performance.now() - tStart) / 1000).toFixed(0)} s; step p50 ${sorted[sorted.length >> 1].toFixed(2)} ms p99 ${sorted[Math.floor(sorted.length * 0.99)].toFixed(1)} ms max ${sorted[sorted.length - 1].toFixed(0)} ms`);
const cps = ctl.checkpoints;
console.log(`CHECKPOINTS: ${cps.list.length} snapshots, last ${mb(cps.list[cps.list.length - 1]?.bytes ?? 0)} MB each, total ${mb(cps.totalBytes)} MB, interval now ${cps.interval} ticks, capture ${(capMs.reduce((x, y) => x + y, 0) / Math.max(1, capMs.length)).toFixed(0)} ms avg`);

// ---- seek timings
for (const frac of [0.9, 0.5, 0.1, 0.0, 0.95]) {
  const target = Math.floor(s.tick * frac);
  const a = performance.now();
  ctl.handle({ type: 'seekTick', tick: target });
  ctl.drainSeek();
  console.log(`SEEK to tick ${target} (${(frac * 100).toFixed(0)}%): ${(performance.now() - a).toFixed(0)} ms, restores ${ctl.restores}, ended at ${ctl.sim!.tick}`);
}
// append cost: feed the rest of the history to the running worker in 1000-commit batches
{
  const rest = commits.slice(appended);
  let worst = 0;
  const a = performance.now();
  for (let i = 0; i < rest.length; i += 1000) {
    const b0 = performance.now();
    ctl.handle({ type: 'append', commits: rest.slice(i, i + 1000) });
    worst = Math.max(worst, performance.now() - b0);
  }
  console.log(`APPEND: ${rest.length} commits in ${rest.length ? Math.ceil(rest.length / 1000) : 0} batches, total ${(performance.now() - a).toFixed(1)} ms, worst batch ${worst.toFixed(2)} ms; sim now ${ctl.sim!.commits.length} commits, horizon ${ctl.sim!.horizon}`);
}
// pack cost at this size
const buf = new Float32Array(ctl.sim!.packCapacity());
const p0 = performance.now();
ctl.sim!.pack(buf);
console.log(`pack: ${(performance.now() - p0).toFixed(1)} ms for ${buf[2]} segments, frame ${(buf.length * 4 / 1048576).toFixed(1)} MB`);
console.log(`rss ${mb(process.memoryUsage().rss)} MB, heap ${mb(process.memoryUsage().heapUsed)} MB`);
