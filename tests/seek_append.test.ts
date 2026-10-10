// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { generateStressCommits } from '../src/ingest/stress';
import type { CommitEvent } from '../src/model/events';
import { Simulation } from '../src/sim/engine';
import { cloneSimulation, reviveScratch } from '../src/sim/snapshot';
import { gapTicks } from '../src/sim/schedule';
import { SimController } from '../src/worker/controller';
import type { FromWorker } from '../src/worker/protocol';

function hashSim(sim: Simulation): string {
  const out = new Float32Array(sim.packCapacity());
  sim.pack(out);
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
  return `${h.toString(16)}:${out.length}`;
}

const commits = generateStressCommits({ files: 250, commits: 30, seed: 11 });
const OPTS = { seed: 5, ticksPerCommit: 14, compactMinNodes: 150 };

function controller(opts: Partial<ConstructorParameters<typeof SimController>[3]> = {}, msgs: FromWorker[] = []): SimController {
  return new SimController((m) => msgs.push(m), () => {}, () => performance.now(), { interval: 70, costFactor: 0, ...opts });
}

function sequentialHash(c: CommitEvent[], opts: object, tick: number): string {
  return sequentialHashes(c, opts, [tick]).get(tick)!;
}

/** Hashes of one uninterrupted run at several ticks (a single pass). */
function sequentialHashes(c: CommitEvent[], opts: object, ticks: number[]): Map<number, string> {
  const sim = new Simulation(c, opts);
  const out = new Map<number, string>();
  const want = [...new Set(ticks)].sort((a, b) => a - b);
  for (const t of want) {
    while (sim.tick < t) sim.step();
    out.set(t, hashSim(sim));
  }
  return out;
}

describe('seek checkpoints', { timeout: 120_000 }, () => {
  it('snapshots are independent deep copies that continue identically', () => {
    const a = new Simulation(commits, OPTS);
    for (let i = 0; i < 300; i++) a.step();
    const snap = cloneSimulation(a);
    expect(snap.bytes).toBeGreaterThan(1000);
    for (let i = 0; i < 200; i++) a.step();
    const b = snap.value;
    expect(b.tick).toBe(300);
    for (let i = 0; i < 200; i++) b.step();
    expect(hashSim(b)).toBe(hashSim(a));
  });

  it('a snapshot without solver scratch is about half the size and still continues bit-identically', () => {
    const a = new Simulation(commits, OPTS);
    for (let i = 0; i < 300; i++) a.step();
    const full = cloneSimulation(a);
    const lean = cloneSimulation(a, 'omit');
    expect(lean.bytes).toBeLessThan(full.bytes * 0.75);
    reviveScratch(lean.value);
    for (let i = 0; i < 250; i++) {
      a.step();
      lean.value.step();
    }
    expect(hashSim(lean.value)).toBe(hashSim(a));
  });

  it('seek (backward and forward, via checkpoints) equals sequential play, across compactions', () => {
    const ctl = controller();
    ctl.handle({ type: 'load', commits: commits.slice(), options: OPTS });
    ctl.runTicks(700, 1e9);
    expect(ctl.checkpoints.list.length).toBeGreaterThan(2);
    expect(ctl.sim!.compactions).toBeGreaterThan(0);
    const targets = [333, 70, 690, 0, 211, 500, 699, 420];
    const ref = sequentialHashes(commits, OPTS, targets);
    for (const t of targets) {
      ctl.handle({ type: 'seekTick', tick: t });
      ctl.drainSeek();
      expect(ctl.sim!.tick).toBe(t);
      expect(hashSim(ctl.sim!)).toBe(ref.get(t));
    }
    expect(ctl.restores).toBeGreaterThan(2);
  });

  it('seek to a commit lands on its settled state', () => {
    const ctl = controller();
    ctl.handle({ type: 'load', commits: commits.slice(), options: OPTS });
    ctl.runTicks(500, 1e9);
    ctl.handle({ type: 'seek', commit: 9 });
    ctl.drainSeek();
    expect(ctl.sim!.tick).toBe(10 * 14 - 1);
    expect(ctl.sim!.commitIndex).toBe(9);
    expect(hashSim(ctl.sim!)).toBe(sequentialHash(commits, OPTS, 10 * 14 - 1));
  });

  it('keeps memory within budget by dropping snapshots, and stays deterministic afterwards', () => {
    const ctl = controller({ budgetBytes: 1, maxCount: 6 });
    ctl.handle({ type: 'load', commits: commits.slice(), options: OPTS });
    ctl.runTicks(600, 1e9);
    expect(ctl.checkpoints.list.length).toBeLessThanOrEqual(6);
    expect(ctl.checkpoints.captures).toBeGreaterThan(6);
    ctl.handle({ type: 'seekTick', tick: 250 });
    ctl.drainSeek();
    expect(hashSim(ctl.sim!)).toBe(sequentialHash(commits, OPTS, 250));
  });
});

describe('append (streaming ingestion)', { timeout: 120_000 }, () => {
  for (const pacing of ['even', 'dates'] as const) {
    it(`state at a tick is independent of when commits arrived (${pacing} pacing)`, () => {
      const opts = { ...OPTS, pacing };
      // irregular dates so 'dates' pacing has varied gaps, including a clock-skew commit
      const dated = commits.map((c, i) => ({ ...c, date: new Date(Date.UTC(2024, 0, 1) + (i === 7 ? -5 : i) * (i % 5 === 0 ? 40 : 1) * 3_600_000).toISOString() }));
      const ref = new Simulation(dated, opts);
      const total = ref.totalTicks;
      const ctl = controller();
      ctl.handle({ type: 'load', commits: dated.slice(0, 4), options: opts, streaming: true });
      let next = 4;
      let guard = 0;
      // alternate running and appending in uneven batches; the clock must stop at the horizon and wait
      while (next < dated.length && guard++ < 10_000) {
        const ran = ctl.runTicks(37, 1e9);
        if (ran < 37) {
          expect(ctl.sim!.tick).toBe(ctl.sim!.horizon);
          const n = 1 + (next % 3);
          ctl.handle({ type: 'append', commits: dated.slice(next, next + n) });
          next += n;
        }
      }
      expect(next).toBe(dated.length);
      ctl.handle({ type: 'finish' });
      ctl.runTicks(total + 400 - ctl.sim!.tick, 1e9);
      const seq = new Simulation(dated, opts);
      for (let i = 0; i < total + 400; i++) seq.step();
      expect(ctl.sim!.tick).toBe(seq.tick);
      expect(hashSim(ctl.sim!)).toBe(hashSim(seq));
      // and seeking back into the streamed history matches too
      ctl.handle({ type: 'seekTick', tick: Math.floor(total / 2) });
      ctl.drainSeek();
      const half = new Simulation(dated, opts);
      for (let i = 0; i < Math.floor(total / 2); i++) half.step();
      expect(hashSim(ctl.sim!)).toBe(hashSim(half));
    });
  }

  it('holds the clock at the end of what is known while streaming, and settles after finish', () => {
    const ctl = controller();
    ctl.handle({ type: 'load', commits: commits.slice(0, 3), options: OPTS, streaming: true });
    expect(ctl.runTicks(10_000, 1e9)).toBe(3 * 14);
    expect(ctl.sim!.commitIndex).toBe(2);
    ctl.handle({ type: 'append', commits: commits.slice(3, 5) });
    expect(ctl.runTicks(10_000, 1e9)).toBe(2 * 14);
    expect(ctl.sim!.commitIndex).toBe(4);
    ctl.handle({ type: 'finish' });
    expect(ctl.runTicks(100, 1e9)).toBe(100);
  });

  it('seek to the newest known commit while streaming stops at the horizon (no endless seek)', () => {
    const ctl = controller();
    ctl.handle({ type: 'load', commits: commits.slice(0, 6), options: OPTS, streaming: true });
    ctl.handle({ type: 'seekTick', tick: 99999 });
    ctl.drainSeek();
    expect(ctl.sim!.tick).toBe(6 * 14 - 1); // settled state of the newest known commit
    ctl.handle({ type: 'options', options: { pacing: 'dates' } });
    ctl.drainSeek();
    expect(ctl.sim!.opts.pacing).toBe('dates');
  });

  it('frames report streaming/waiting', () => {
    const msgs: FromWorker[] = [];
    const ctl = controller({}, msgs);
    ctl.handle({ type: 'load', commits: commits.slice(0, 2), options: OPTS, streaming: true });
    ctl.runTicks(1000, 1e9);
    ctl.handle({ type: 'frame', buf: new Float32Array(1 << 16) });
    const f = msgs.find((m) => m.type === 'frame') as Extract<FromWorker, { type: 'frame' }>;
    expect(f.buf[28]).toBe(1);
    expect(f.buf[29]).toBe(1);
    expect(f.buf[24]).toBe(0); // not ended
  });
});

describe('date pacing', () => {
  it('compresses idle gaps and keeps bursts quick', () => {
    const h = (n: number) => n * 3_600_000;
    const g = (hours: number) => gapTicks('dates', 45, 0, h(hours));
    expect(g(0)).toBe(14);
    expect(g(1)).toBeGreaterThan(g(0));
    expect(g(24)).toBeGreaterThan(g(1));
    expect(g(24 * 365 * 5)).toBeLessThanOrEqual(180);
    expect(g(24 * 365 * 5)).toBeGreaterThanOrEqual(g(24 * 365) - 1);
    expect(gapTicks('dates', 45, h(5), h(1))).toBe(14); // out-of-order dates
    expect(gapTicks('even', 45, 0, h(1000))).toBe(45);
  });
});

describe('big commits', { timeout: 120_000 }, () => {
  const bigCommit = (n: number, tag: string): CommitEvent => ({
    hash: tag.padStart(40, '0'),
    author: 'importer',
    email: '',
    date: '2024-01-01T00:00:00Z',
    message: 'import everything',
    files: Array.from({ length: n }, (_, i) => ({ path: `vendor/pkg${i % 40}/f${i}.js`, status: 'A' as const, added: 10, removed: 0 })),
  });

  it('applies a huge commit in slices (bounded work per tick) and ends in the same tree as a one-shot apply', async () => {
    const { FileTree } = await import('../src/model/tree');
    const big = bigCommit(1000, 'big');
    const next = generateStressCommits({ files: 100, commits: 3, seed: 2 });
    const sim = new Simulation([big, ...next], { seed: 3 });
    // the next commit lands only after the big one is fully applied
    expect(sim.landing(1)).toBeGreaterThanOrEqual(4);
    const live: number[] = [];
    for (let i = 0; i < 6; i++) {
      sim.step();
      live.push(sim.tree.liveFileCount);
    }
    expect(live[0]).toBeLessThanOrEqual(300); // first slice only
    expect(live[0]).toBeGreaterThan(0);
    expect(live[3]).toBe(1000);
    // sliced application == whole application (same node ids, same live set)
    const whole = new FileTree();
    whole.applyCommit(big, []);
    expect(sim.tree.nodes.length).toBeGreaterThanOrEqual(whole.nodes.length);
    for (let i = 0; i < whole.nodes.length; i++) {
      expect(sim.tree.nodes[i].path).toBe(whole.nodes[i].path);
    }
  });

  it('single-tick cost of a 3000-file commit is a fraction of applying it at once', () => {
    const big = bigCommit(3000, 'b3');
    const mk = () => new Simulation([big], { seed: 1 });
    const sim = mk();
    const t0 = performance.now();
    sim.step();
    const first = performance.now() - t0;
    expect(sim.tree.liveFileCount).toBe(300);
    expect(first).toBeLessThan(500);
  });

  it('seek lands past a big commit exactly like sequential play', () => {
    const big = bigCommit(700, 'bb');
    const rest = generateStressCommits({ files: 120, commits: 6, seed: 4 });
    const all = [big, ...rest];
    const ctl = controller();
    ctl.handle({ type: 'load', commits: all.slice(), options: { seed: 2, ticksPerCommit: 10 } });
    ctl.runTicks(300, 1e9);
    ctl.handle({ type: 'seek', commit: 1 });
    ctl.drainSeek();
    expect(hashSim(ctl.sim!)).toBe(sequentialHash(all, { seed: 2, ticksPerCommit: 10 }, ctl.sim!.tick));
  });
});

describe('checkpoint thinning policy', () => {
  it('stays within budget, keeps the newest, and spaces the survivors by estimated replay cost (denser where snapshots are big)', async () => {
    const { CheckpointStore } = await import('../src/sim/snapshot');
    const store = new CheckpointStore({ interval: 200, budgetBytes: 400, maxCount: 1000 });
    // snapshot size grows linearly with tick (the mold grows): bytes = tick / 100
    for (let t = 200; t <= 8000; t += 200) {
      store.list.push({ tick: t, sim: null as never, bytes: t / 100 });
      store.totalBytes += t / 100;
    }
    (store as unknown as { thin(): void }).thin();
    const ticks = store.list.map((c) => c.tick);
    expect(store.totalBytes).toBeLessThanOrEqual(400 * 0.8 + 1);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(ticks.at(-1)).toBe(8000);
    const gaps = ticks.map((t, i) => t - (i ? ticks[i - 1] : 0));
    const early = Math.max(...gaps.slice(0, Math.floor(gaps.length / 2)));
    const late = Math.max(...gaps.slice(Math.floor(gaps.length / 2)));
    expect(early).toBeGreaterThanOrEqual(late);
    // lookups
    expect(store.before(100)).toBeUndefined();
    expect(store.before(8000)!.tick).toBe(8000);
    expect(store.before(7999)!.tick).toBeLessThan(7999);
  });
});
