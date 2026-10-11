// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Beat follower. Feed it the low-frequency (kick) energy of the music once per frame; it returns a pulse in 0..1 that jumps
 * to 1 on each detected beat and falls off. The threshold adapts to the track's own loudness, so no bpm is needed.
 * Pure: no DOM, no audio. The player (src/ui/music.ts) feeds it, the render loop (src/main.ts) reads `beatState.level`.
 */
export interface BeatOptions {
  /** A beat is energy above `ratio` times the slow average, plus `floor`. */
  ratio: number;
  floor: number;
  /** Minimum seconds between beats (0.25 s = up to 240 bpm). */
  refractory: number;
  /** Seconds for the pulse to fall from 1 to 0. */
  decay: number;
  /** Seconds the slow average takes to follow the energy. */
  avgTime: number;
}

export const BEAT_DEFAULTS: BeatOptions = { ratio: 1.25, floor: 0.04, refractory: 0.25, decay: 0.45, avgTime: 1.5 };

export class BeatTracker {
  private avg = 0;
  private since = Infinity;
  private pulse = 0;
  private primed = false;

  constructor(private o: BeatOptions = BEAT_DEFAULTS) {}

  /** energy: 0..1, dt: seconds since the previous call. Returns the pulse, 0..1. */
  update(energy: number, dt: number): number {
    const e = Math.min(1, Math.max(0, energy));
    const step = Math.min(0.1, Math.max(0, dt));
    if (!this.primed) {
      this.avg = e; // start from the first sample, so a steady sound is not heard as a beat
      this.primed = true;
    }
    this.since += step;
    this.pulse = Math.max(0, this.pulse - step / this.o.decay);
    if (e > this.avg * this.o.ratio + this.o.floor && this.since >= this.o.refractory) {
      this.pulse = 1;
      this.since = 0;
    }
    this.avg += (e - this.avg) * Math.min(1, step / this.o.avgTime);
    return this.pulse;
  }

  /** Playback stopped: forget the beat (the pulse then decays through update(0, dt)). */
  reset(): void {
    this.avg = 0;
    this.since = Infinity;
    this.pulse = 0;
    this.primed = false;
  }
}

/** Shared between the player (landing chunk) and the render loop (engine chunk); neither imports the other. */
export const beatState = { level: 0 };
