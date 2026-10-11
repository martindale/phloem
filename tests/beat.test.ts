// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BeatTracker } from '../src/util/beat';

const FPS = 60;
/** A kick drum at `bpm`: a short burst of energy on each beat over a quiet bed. */
function run(bpm: number, secs: number, bed = 0.1, hit = 0.8): number[] {
  const t = new BeatTracker();
  const beats: number[] = [];
  const period = 60 / bpm;
  let prev = 0;
  for (let i = 0; i < secs * FPS; i++) {
    const time = i / FPS;
    const phase = time % period;
    const e = phase < 0.08 ? hit : bed;
    const p = t.update(e, 1 / FPS);
    if (p === 1 && prev < 1) beats.push(time);
    prev = p;
  }
  return beats;
}

describe('BeatTracker', () => {
  it('finds one beat per kick at 70, 80 and 90 bpm', () => {
    for (const bpm of [70, 80, 90]) {
      const beats = run(bpm, 20);
      const expected = (20 * bpm) / 60;
      expect(Math.abs(beats.length - expected)).toBeLessThanOrEqual(2);
    }
  });
  it('stays quiet on a steady sound with no kick', () => {
    expect(run(80, 10, 0.3, 0.3).length).toBeLessThanOrEqual(1);
  });
  it('stays quiet on silence and falls back to 0 after a beat', () => {
    const t = new BeatTracker();
    for (let i = 0; i < 120; i++) expect(t.update(0, 1 / FPS)).toBe(0);
    t.update(0.9, 1 / FPS);
    let p = 1;
    for (let i = 0; i < 60; i++) p = t.update(0, 1 / FPS);
    expect(p).toBe(0);
  });
  it('keeps the pulse inside 0..1 for out-of-range input', () => {
    const t = new BeatTracker();
    for (const e of [-5, 9, 0, 2, -1]) {
      const p = t.update(e, 1 / FPS);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});
