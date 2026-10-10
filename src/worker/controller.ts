// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import { Simulation, type SimOptions } from '../sim/engine';
import { H } from '../sim/frame';
import { CheckpointStore, cloneSimulation, reviveScratch, type CheckpointOptions } from '../sim/snapshot';
import type { FromWorker, ToWorker } from './protocol';

/**
 * The sim worker's brain, free of `self`/timers so tests can drive it: owns the Simulation, the commit list (growing through
 * `append`), playback state, seeking with checkpoints, and frame production.
 *
 * Determinism contract: the state at tick t is a function of (commits that land before t, seed, options) only. Appending never
 * changes it, because while `streaming` the clock is held at `sim.horizon` (no commit can land earlier than that without
 * being known). Seeking restores the nearest earlier checkpoint (a deep copy taken at a tick boundary) and steps forward, which
 * is bit-identical to stepping from tick 0.
 */
export const BASE_TICKS_PER_SEC = 60;
export const SETTLE_TICKS = 900; // keep simulating this long after the last commit

export class SimController {
  sim: Simulation | null = null;
  commits: CommitEvent[] = [];
  options: Partial<SimOptions> = {};
  streaming = false;
  playing = true;
  speed = 1;
  checkpoints: CheckpointStore;
  seekTarget = -1;
  seekTicksDone = 0;
  private seekFresh = false;
  stepMsEma = 0;
  restores = 0;
  private acc = 0;
  private lastTime = 0;
  private frameId = 0;
  private infoSent = 0;
  private infoCount = -1;

  constructor(
    private post: (msg: FromWorker, transfer?: Transferable[]) => void,
    /** Called when a seek needs more work: the host should call `seekWork` soon (setTimeout 0). */
    private scheduleSeek: () => void,
    private clock: () => number = () => performance.now(),
    checkpointOptions: Partial<CheckpointOptions> = {},
  ) {
    this.checkpoints = new CheckpointStore(checkpointOptions);
  }

  // ------------------------------------------------------------ messages
  handle(msg: ToWorker): void {
    try {
      switch (msg.type) {
        case 'load':
          this.commits = msg.commits;
          this.options = msg.options ?? {};
          this.streaming = msg.streaming === true;
          this.seekTarget = -1;
          this.seekFresh = false;
          this.reset();
          this.post({ type: 'ready', totalCommits: this.commits.length, ticksPerCommit: this.sim!.opts.ticksPerCommit });
          break;
        case 'append':
          if (!this.sim) break;
          this.sim.append(msg.commits);
          break;
        case 'finish':
          this.streaming = false;
          if (this.sim) this.sim.streaming = false;
          break;
        case 'options': {
          if (!this.sim) break;
          const at = this.sim.commitIndex;
          this.options = { ...this.options, ...msg.options };
          this.reset();
          if (at >= 0) this.seekCommit(at);
          break;
        }
        case 'play':
          this.playing = msg.playing;
          break;
        case 'speed':
          this.speed = msg.speed;
          break;
        case 'seek':
          this.seekCommit(msg.commit);
          break;
        case 'seekTick':
          this.seekTarget = Math.max(0, Math.floor(msg.tick));
          this.seekFresh = true;
          this.scheduleSeek();
          break;
        case 'frame':
          this.frame(msg.buf);
          break;
      }
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
    }
  }

  private seekCommit(c: number): void {
    if (!this.sim) return;
    const i = Math.max(0, Math.min(this.commits.length - 1, c));
    this.seekTarget = this.sim.settledTick(i);
    this.seekFresh = true;
    this.scheduleSeek();
  }

  private fresh(): void {
    this.sim = new Simulation(this.commits, this.options);
    this.sim.streaming = this.streaming;
    this.acc = 0;
  }

  /** New timeline (load / changed options): drops every checkpoint. */
  private reset(): void {
    this.fresh();
    this.checkpoints.clear();
  }

  // ------------------------------------------------------------ stepping
  /** Step up to `n` ticks (stopping at the streaming horizon), capturing checkpoints. Returns ticks done. */
  runTicks(n: number, budgetMs: number): number {
    const sim = this.sim;
    if (!sim) return 0;
    const t0 = this.clock();
    let done = 0;
    while (done < n && sim.tick < sim.horizon) {
      const a = this.clock();
      sim.step();
      const dt = this.clock() - a;
      this.stepMsEma = this.stepMsEma === 0 ? dt : this.stepMsEma * 0.95 + dt * 0.05;
      done++;
      this.checkpoints.maybeCapture(sim, this.stepMsEma);
      if (this.clock() - t0 > budgetMs) break;
    }
    return done;
  }

  /** Put the nearest checkpoint at or before `tick` in place of the running sim if that saves work. */
  private restoreFor(target: number): void {
    const sim = this.sim!;
    const cp = this.checkpoints.before(target);
    if (target < sim.tick) {
      if (cp) this.adopt(cp.sim);
      else this.fresh();
    } else if (cp && cp.tick - sim.tick >= this.checkpoints.interval) {
      this.adopt(cp.sim);
    }
  }

  private adopt(snapshot: Simulation): void {
    const c = cloneSimulation(snapshot);
    reviveScratch(c.value);
    c.value.streaming = this.streaming;
    this.sim = c.value;
    this.restores++;
  }

  /**
   * Fast-forward toward the seek target for up to `budgetMs`. Returns true when the host should call again. Run on the worker's
   * own event loop so seeking is not throttled by the main thread's frame rate.
   */
  seekWork(budgetMs = 30): boolean {
    if (!this.sim || this.seekTarget < 0) return false;
    if (this.seekFresh) {
      this.seekFresh = false;
      this.restoreFor(this.seekTarget);
    }
    const target = Math.min(this.seekTarget, this.sim!.horizon - 1);
    this.seekTicksDone += this.runTicks(target - this.sim!.tick, budgetMs);
    if (this.sim!.tick >= target) {
      this.seekTarget = -1;
      this.lastTime = 0;
      this.acc = 0;
      return false;
    }
    return true;
  }

  /** Test helper: complete the pending seek synchronously. */
  drainSeek(): void {
    while (this.seekWork(1e9)) {
      /* keep going */
    }
    this.seekTicksDone = 0;
  }

  private advance(): number {
    const sim = this.sim;
    if (!sim) return 0;
    const now = this.clock();
    const dtMs = this.lastTime === 0 ? 16 : Math.min(100, now - this.lastTime);
    this.lastTime = now;
    if (this.seekTarget >= 0) {
      const n = this.seekTicksDone;
      this.seekTicksDone = 0;
      return n;
    }
    const end = sim.totalTicks + SETTLE_TICKS;
    if (!this.playing || sim.tick >= end) {
      this.acc = 0;
      return 0;
    }
    this.acc += (dtMs / 1000) * BASE_TICKS_PER_SEC * this.speed;
    let n = Math.floor(this.acc);
    const cap = Math.max(2, Math.ceil(3 * this.speed));
    if (n > cap) n = cap; // drop backlog instead of spiralling
    this.acc -= Math.floor(this.acc);
    return this.runTicks(Math.min(n, end - sim.tick), 14);
  }

  // ------------------------------------------------------------ frames
  private frame(bufIn: Float32Array): void {
    let buf = bufIn;
    const sim = this.sim;
    if (!sim) {
      this.post({ type: 'frame', buf }, [buf.buffer]);
      return;
    }
    const ticks = this.advance();
    const need = sim.packCapacity();
    if (buf.length < need) buf = new Float32Array(Math.ceil(need * 1.5));
    const p0 = this.clock();
    sim.pack(buf);
    buf[H.packMs] = this.clock() - p0;
    buf[H.stepMs] = this.stepMsEma;
    buf[H.ticksThisFrame] = ticks;
    buf[H.seeking] = this.seekTarget >= 0 ? 1 : 0;
    const waiting = sim.streaming && sim.tick >= sim.horizon;
    const ended = !sim.streaming && sim.tick >= sim.totalTicks + SETTLE_TICKS;
    buf[H.playing] = this.playing && !ended ? 1 : 0;
    buf[H.ended] = ended ? 1 : 0;
    buf[H.speed] = this.speed;
    buf[H.frameId] = ++this.frameId;
    buf[H.streaming] = sim.streaming ? 1 : 0;
    buf[H.waiting] = waiting ? 1 : 0;
    this.post({ type: 'frame', buf }, [buf.buffer]);
    this.maybeInfo();
  }

  private maybeInfo(): void {
    const cs = this.checkpoints;
    const now = this.clock();
    if (cs.list.length === this.infoCount || now - this.infoSent < 1000) return;
    this.infoSent = now;
    this.infoCount = cs.list.length;
    this.post({
      type: 'info',
      checkpoints: { count: cs.list.length, bytes: cs.totalBytes, interval: cs.interval, lastCaptureMs: cs.lastCaptureMs },
    });
  }
}
