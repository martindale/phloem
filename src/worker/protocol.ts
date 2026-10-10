// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import type { SimOptions } from '../sim/engine';

/** Main thread -> sim worker. */
export type ToWorker =
  /**
   * (Re)load a history. Resets the simulation. With `streaming`, more commits may follow via `append` and the clock waits at
   * the end of what is known (instead of settling and ending) until `finish`.
   */
  | { type: 'load'; commits: CommitEvent[]; options?: Partial<SimOptions>; streaming?: boolean }
  /** More commits, oldest first, continuing the loaded history. Playback keeps running. */
  | { type: 'append'; commits: CommitEvent[] }
  /** No more commits will arrive: leave streaming mode (the timeline can now settle and end). */
  | { type: 'finish' }
  /** Change simulation options that alter the timeline (pacing, ticksPerCommit). Rebuilds the sim and returns to the same commit. */
  | { type: 'options'; options: Partial<SimOptions> }
  /** Hand a frame buffer to the worker: it advances the sim by wall-clock time and fills it. */
  | { type: 'frame'; buf: Float32Array }
  | { type: 'play'; playing: boolean }
  | { type: 'speed'; speed: number }
  /** Jump to the settled state of commit `commit` (deterministic fast-forward from the nearest checkpoint). */
  | { type: 'seek'; commit: number }
  /** Jump to an exact sim tick (tests, deep links). */
  | { type: 'seekTick'; tick: number };

export interface CheckpointInfo {
  count: number;
  bytes: number;
  interval: number;
  lastCaptureMs: number;
}

/** Sim worker -> main thread. */
export type FromWorker =
  | { type: 'ready'; totalCommits: number; ticksPerCommit: number }
  /** Filled frame (see sim/frame.ts for the layout). Ownership is transferred. */
  | { type: 'frame'; buf: Float32Array }
  /** Checkpoint bookkeeping, sent when it changed (at most about once a second). */
  | { type: 'info'; checkpoints: CheckpointInfo }
  | { type: 'error'; message: string };
