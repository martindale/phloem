// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCommitEvents } from '../src/model/parse';
import {
  BURSTS, FLOOD_FRONT, GHOST_ALPHA, GHOST_LIFE, burstEnergy, floodAt, floodDuration, ghostAlpha, packEmit, unpackEmit,
} from '../src/sim/activity';
import { Simulation } from '../src/sim/engine';
import { BURST_STRIDE, H, readSegment } from '../src/sim/frame';
import { QualityGovernor, lowerTier, parseQuality, tierEffects } from '../src/render/quality';

const fixture = parseCommitEvents(JSON.parse(readFileSync(new URL('../fixtures/stemdeck-first10.json', import.meta.url), 'utf8')));

function packed(sim: Simulation): Float32Array {
  const out = new Float32Array(sim.packCapacity());
  sim.pack(out);
  return out;
}

describe('burst energy', () => {
  it('is 0 for empty commits, grows with the commit size on a log scale and never exceeds 1', () => {
    expect(burstEnergy(0)).toBe(0);
    expect(burstEnergy(NaN)).toBe(0);
    const one = burstEnergy(1);
    expect(one).toBeGreaterThan(0.1);
    expect(one).toBeLessThan(0.3);
    let prev = 0;
    for (const n of [1, 2, 5, 15, 40, 100, 142]) {
      const e = burstEnergy(n);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
    expect(burstEnergy(142)).toBeGreaterThan(0.95);
    expect(burstEnergy(150)).toBeCloseTo(1, 6);
    expect(burstEnergy(1e6)).toBe(1);
    // log scale: 10x the files is far less than 10x the energy
    expect(burstEnergy(100) / burstEnergy(10)).toBeLessThan(2);
  });

  it('flood shape: peaks at the front, sharp ahead, long wake behind, fades with travel', () => {
    const reach = 400;
    const front = 100;
    const at = (d: number) => floodAt(d, front, 1, reach);
    expect(at(front)).toBeGreaterThan(at(front + FLOOD_FRONT * 2)); // ahead of the front: dark
    expect(at(front + FLOOD_FRONT * 2)).toBeLessThan(0.05);
    expect(at(front - 30)).toBeGreaterThan(0.3); // the wake still glows
    expect(at(front - 30)).toBeLessThan(at(front));
    for (let d = 0; d < 600; d += 7) {
      expect(at(d)).toBeGreaterThanOrEqual(0);
      expect(at(d)).toBeLessThanOrEqual(1);
    }
    // energy scales it, a dead burst contributes nothing, and the wave is gone after floodDuration
    expect(floodAt(front, front, 0.5, reach)).toBeCloseTo(0.5 * at(front), 6);
    expect(floodAt(front, front, 0, reach)).toBe(0);
    expect(floodAt(50, -1, 1, reach)).toBe(0);
    expect(floodAt(reach, floodDuration(reach) * 4.2, 1, reach)).toBeLessThan(1e-6);
    expect(floodAt(front, front, 1, reach)).toBeGreaterThan(floodAt(300, 300, 1, reach));
  });

  it('ghost alpha fades from GHOST_ALPHA to 0 over GHOST_LIFE', () => {
    expect(ghostAlpha(0)).toBeCloseTo(GHOST_ALPHA);
    expect(ghostAlpha(GHOST_LIFE / 2)).toBeLessThan(GHOST_ALPHA / 2);
    expect(ghostAlpha(GHOST_LIFE)).toBe(0);
    expect(ghostAlpha(-1)).toBe(0);
  });

  it('packs heat and warmth into one byte', () => {
    for (const [h, w] of [[0, 0], [1, 1], [0.5, 0.2], [0.93, 0.07], [2, -1]]) {
      const b = packEmit(h, w);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
      const u = unpackEmit(b);
      expect(u.heat).toBeCloseTo(Math.min(1, Math.max(0, h)), 1);
      expect(u.warm).toBeCloseTo(Math.min(1, Math.max(0, w)), 1);
    }
  });
});

describe('quality tiers', () => {
  it('parses ?quality= (a tier pins it, anything else is auto starting high)', () => {
    expect(parseQuality('low')).toEqual({ tier: 'low', auto: false });
    expect(parseQuality(' Medium ')).toEqual({ tier: 'medium', auto: false });
    expect(parseQuality('high')).toEqual({ tier: 'high', auto: false });
    expect(parseQuality('auto')).toEqual({ tier: 'high', auto: true });
    expect(parseQuality(null)).toEqual({ tier: 'high', auto: true });
    expect(parseQuality('ultra')).toEqual({ tier: 'high', auto: true });
  });

  it('tiers get strictly cheaper going down', () => {
    const lo = tierEffects('low');
    const me = tierEffects('medium');
    const hi = tierEffects('high');
    expect(lo.particles).toBe(0);
    expect(lo.gel || lo.ghosts || lo.radiusPulse).toBe(false);
    expect(lo.streaming).toBe(0);
    expect(me.particles).toBeLessThan(hi.particles);
    expect(me.streaming).toBeLessThan(hi.streaming);
    expect(lowerTier('high')).toBe('medium');
    expect(lowerTier('medium')).toBe('low');
    expect(lowerTier('low')).toBeNull();
    // fresh copies: changing one does not change the table
    hi.particles = 1;
    expect(tierEffects('high').particles).toBeGreaterThan(1);
  });

  /** Drive the governor with frames of `dt` ms (optionally a GPU time) for `ms` ms. */
  function run(g: QualityGovernor, t: number, ms: number, dt: number, gpu = -1): { t: number; changes: string[] } {
    const changes: string[] = [];
    let seq = 0;
    for (const end = t + ms; t < end; t += dt) {
      const c = g.frame(t, gpu, gpu >= 0 ? seq++ : -1);
      if (c) changes.push(c);
    }
    return { t, changes };
  }

  it('keeps the tier at a steady 60 fps, and never touches a pinned tier', () => {
    const g = new QualityGovernor(parseQuality(null));
    expect(run(g, 0, 20000, 16.7).changes).toEqual([]);
    const pinned = new QualityGovernor(parseQuality('high'));
    expect(run(pinned, 0, 20000, 100).changes).toEqual([]);
    expect(pinned.tier).toBe('high');
  });

  it('frame-time fallback: steps down one tier per sustained slow period, never below low, never back up', () => {
    const g = new QualityGovernor(parseQuality(null));
    let r = run(g, 0, 3000, 16.7); // learns the 60 Hz refresh
    r = run(g, r.t, 4000, 40); // 25 fps: slow
    expect(r.changes).toEqual(['medium']);
    r = run(g, r.t, 6500, 40);
    expect(r.changes).toEqual(['low']);
    r = run(g, r.t, 10000, 40);
    expect(r.changes).toEqual([]);
    expect(g.tier).toBe('low');
    r = run(g, r.t, 20000, 16.7);
    expect(r.changes).toEqual([]);
    expect(g.reason).toMatch(/frame/);
  });

  it('ignores short hitches, warm-up and huge gaps (hidden tab)', () => {
    const g = new QualityGovernor(parseQuality(null));
    let r = run(g, 0, 2000, 60); // slow but inside the warm-up window
    expect(r.changes).toEqual([]);
    r = run(g, r.t, 3000, 16.7);
    r = run(g, r.t, 1200, 45); // shorter than sustainMs
    r = run(g, r.t, 3000, 16.7);
    expect(r.changes).toEqual([]);
    r = run(g, r.t, 30000, 5000); // background tab: rAF every 5 s
    expect(r.changes).toEqual([]);
    expect(g.tier).toBe('high');
  });

  it('uses the GPU timer when present: over budget steps down even at a smooth frame rate', () => {
    const g = new QualityGovernor(parseQuality(null), { gpuBudgetMs: 12 });
    let r = run(g, 0, 8000, 16.7, 6);
    expect(r.changes).toEqual([]);
    r = run(g, r.t, 4000, 16.7, 15);
    expect(r.changes).toEqual(['medium']);
    expect(g.reason).toMatch(/gpu/);
    // a slow frame rate with a cheap GPU is not the renderer's fault
    const h = new QualityGovernor(parseQuality(null));
    r = run(h, 0, 3000, 16.7, 4);
    r = run(h, r.t, 8000, 40, 4);
    expect(r.changes).toEqual([]);
  });
});

describe('activity signals in the frame', () => {
  it('records commit bursts newest first, sized by the commit', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    for (let t = 0; t < 45 * 3 + 5; t++) sim.step();
    const out = packed(sim);
    const ticks: number[] = [];
    for (let k = 0; k < BURSTS; k++) {
      const o = H.bursts + k * BURST_STRIDE;
      if (out[o + 1] <= 0) continue;
      ticks.push(out[o]);
      expect(out[o + 1]).toBeLessThanOrEqual(1);
      expect(out[o + 2]).toBeGreaterThanOrEqual(0);
      expect(out[o + 2]).toBeLessThan(1);
    }
    expect(ticks).toEqual([135, 90, 45, 0]);
    expect(out[H.bursts + 1]).toBeCloseTo(burstEnergy(fixture[3].files.length), 6);
    expect(out[H.activity]).toBeGreaterThan(0);
    expect(out[H.activity]).toBeLessThanOrEqual(1);
  });

  it('packs growth distance, warmth, hot-spot and ghosts consistently', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    let out = new Float32Array(16);
    let sawGhosts = 0;
    let sawHot = false;
    for (let t = 0; t < 45 * 10 + 700; t++) {
      sim.step();
      if (t % 50 !== 0) continue;
      if (out.length < sim.packCapacity()) out = new Float32Array(sim.packCapacity());
      sim.pack(out);
      const distMax = out[H.distMax];
      expect(Math.log2(distMax) % 1).toBe(0);
      expect(distMax).toBeGreaterThanOrEqual(Math.max(256, out[H.reach]));
      const segs = out[H.segs];
      const ghosts = out[H.ghosts];
      expect(ghosts).toBeLessThanOrEqual(segs);
      for (let k = 0; k < segs; k++) {
        const g = readSegment(out, k);
        expect(g.dist).toBeGreaterThanOrEqual(0);
        expect(g.dist).toBeLessThanOrEqual(out[H.reach] + 1e-3 + distMax / 65535);
        expect(g.warm).toBeGreaterThanOrEqual(0);
        expect(g.warm).toBeLessThanOrEqual(1);
        if (k >= segs - ghosts) {
          // ghosts: faint, no heat/warmth, below the ghost alpha the renderer keys on
          expect(g.alpha).toBeGreaterThan(0);
          expect(g.alpha).toBeLessThanOrEqual(GHOST_ALPHA + 1e-3);
          expect(g.emit).toBe(0);
        } else expect(g.alpha).toBeGreaterThanOrEqual(0.19);
      }
      sawGhosts = Math.max(sawGhosts, ghosts);
      if (out[H.hotW] > 0) {
        sawHot = true;
        for (const [v, lo, hi] of [[H.hotX, H.minX, H.maxX], [H.hotY, H.minY, H.maxY], [H.hotZ, H.minZ, H.maxZ]]) {
          expect(out[v]).toBeGreaterThanOrEqual(out[lo] - 1e-3);
          expect(out[v]).toBeLessThanOrEqual(out[hi] + 1e-3);
        }
        expect(out[H.hotR]).toBeGreaterThanOrEqual(0);
      }
    }
    expect(sawHot).toBe(true);
    expect(sawGhosts).toBeGreaterThan(0);
  });

  it('warmth: pulses and growth warm the network, dormant veins cool down', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    for (let t = 0; t < 45 * 10; t++) sim.step();
    const meanWarm = (out: Float32Array) => {
      let s = 0;
      const n = out[H.segs] - out[H.ghosts];
      for (let k = 0; k < n; k++) s += readSegment(out, k).warm;
      return s / n;
    };
    const active = meanWarm(packed(sim));
    for (let t = 0; t < 2500; t++) sim.step(); // long settling: no commits, no pulses
    const dormant = meanWarm(packed(sim));
    expect(active).toBeGreaterThan(0.3);
    expect(dormant).toBeLessThan(active * 0.5);
  });
});
