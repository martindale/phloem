// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import type { SimOptions } from '../sim/engine';
import type { CheckpointInfo, FromWorker, ToWorker } from './protocol';

/**
 * Main-thread handle on the sim worker. Exactly one frame buffer circulates:
 * worker fills it -> `latest` -> renderer uploads -> pump() sends it back.
 */
export class SimClient {
  private worker: Worker;
  private latest: Float32Array | null = null;
  private inFlight = false;
  private spare: Float32Array | null = new Float32Array(1 << 16);
  totalCommits = 0;
  ticksPerCommit = 1;
  /** Latest checkpoint stats from the worker (null until the first report). */
  checkpoints: CheckpointInfo | null = null;
  onReady: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const msg = ev.data;
      if (msg.type === 'frame') {
        this.latest = msg.buf;
        this.inFlight = false;
      } else if (msg.type === 'ready') {
        this.totalCommits = msg.totalCommits;
        this.ticksPerCommit = msg.ticksPerCommit;
        this.onReady?.();
      } else if (msg.type === 'info') {
        this.checkpoints = msg.checkpoints;
      } else if (msg.type === 'error') {
        this.onError?.(msg.message);
      }
    };
    this.worker.onerror = (e) => this.onError?.(e.message);
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  /** Replace the history. `streaming`: more commits will follow through `append()`; call `finish()` after the last one. */
  load(commits: CommitEvent[], options?: Partial<SimOptions>, streaming = false): void {
    this.send({ type: 'load', commits, options, streaming });
  }
  append(commits: CommitEvent[]): void {
    if (commits.length) this.send({ type: 'append', commits });
  }
  finish(): void {
    this.send({ type: 'finish' });
  }
  /** Change timeline options (e.g. `{ pacing: 'dates' }`); the sim restarts and returns to the current commit. */
  setOptions(options: Partial<SimOptions>): void {
    this.send({ type: 'options', options });
  }
  setPlaying(playing: boolean): void {
    this.send({ type: 'play', playing });
  }
  setSpeed(speed: number): void {
    this.send({ type: 'speed', speed });
  }
  seek(commit: number): void {
    this.send({ type: 'seek', commit });
  }
  seekTick(tick: number): void {
    this.send({ type: 'seekTick', tick });
  }

  /** Newest filled frame not yet consumed (or null). */
  take(): Float32Array | null {
    const f = this.latest;
    this.latest = null;
    return f;
  }

  /** Return a consumed frame buffer and request the next one. Call once per animation frame. */
  pump(consumed: Float32Array | null): void {
    if (consumed) this.spare = consumed;
    if (this.inFlight || !this.spare) return;
    const buf = this.spare;
    this.spare = null;
    this.inFlight = true;
    this.send({ type: 'frame', buf }, [buf.buffer]);
  }
}
