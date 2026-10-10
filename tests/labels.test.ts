// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LabelModel } from '../src/labels/model';
import {
  ACTIVE_FADE,
  ACTIVE_HOLD,
  FLASH_TIME,
  LabelPlanner,
  PIN_SCORE,
  SLOT_COUNT,
  activity,
  ambientFileLod,
  flash,
  FOLDER_LOD_MIN,
  folderAlpha,
  labelBudget,
  folderLod,
  folderScore,
  slotOffset,
  smoothTo,
  stepAlpha,
  wobbleAt,
} from '../src/labels/select';
import { parseCommitEvents } from '../src/model/parse';
import { authorHue } from '../src/model/rng';
import { Simulation } from '../src/sim/engine';

const fixture = parseCommitEvents(JSON.parse(readFileSync(new URL('../fixtures/stemdeck-first10.json', import.meta.url), 'utf8')));

describe('label curves', () => {
  it('activity holds, then fades linearly to zero, and is zero when never touched', () => {
    expect(activity(0)).toBe(1);
    expect(activity(ACTIVE_HOLD)).toBe(1);
    expect(activity(ACTIVE_HOLD + ACTIVE_FADE / 2)).toBeCloseTo(0.5, 6);
    expect(activity(ACTIVE_HOLD + ACTIVE_FADE)).toBe(0);
    expect(activity(Infinity)).toBe(0);
    expect(activity(NaN)).toBe(0);
  });

  it('flash is a short decaying highlight', () => {
    expect(flash(0)).toBe(1);
    expect(flash(FLASH_TIME / 2)).toBeLessThan(0.3);
    expect(flash(FLASH_TIME)).toBe(0);
    expect(flash(Infinity)).toBe(0);
  });

  it('folder LOD grows with zoom and subtree size, and is bounded', () => {
    expect(folderLod(1, 0.3)).toBe(0);
    expect(folderLod(400, 3)).toBe(1);
    expect(folderLod(100, 1)).toBeGreaterThan(folderLod(20, 1));
    expect(folderLod(30, 2)).toBeGreaterThan(folderLod(30, 1));
    for (const z of [0.1, 1, 5]) for (const n of [1, 10, 1000]) expect(folderLod(n, z)).toBeGreaterThanOrEqual(0);
  });

  it('folder alpha never shows a faint ghost', () => {
    expect(folderAlpha(FOLDER_LOD_MIN)).toBeGreaterThanOrEqual(0.5);
    expect(folderAlpha(1)).toBe(1);
  });

  it('label budget grows with on-screen scale and stays within the caps', () => {
    expect(labelBudget('all', 0.3)).toBeLessThan(labelBudget('all', 4));
    expect(labelBudget('all', 100)).toBeLessThanOrEqual(90);
    expect(labelBudget('active', 100)).toBeLessThanOrEqual(40);
    expect(labelBudget('active', 0.1)).toBeGreaterThan(10);
  });

  it('ambient file labels only appear when zoomed in', () => {
    expect(ambientFileLod(0.5)).toBe(0);
    expect(ambientFileLod(6)).toBe(1);
  });

  it('bigger and shallower folders score higher', () => {
    expect(folderScore(500, 1)).toBeGreaterThan(folderScore(5, 1));
    expect(folderScore(50, 1)).toBeGreaterThan(folderScore(50, 4));
  });

  it('fade steps are monotone, clamped and use separate in/out times', () => {
    expect(stepAlpha(0, 1, 0.1, 0.2, 0.4)).toBeCloseTo(0.5, 6);
    expect(stepAlpha(1, 0, 0.1, 0.2, 0.4)).toBeCloseTo(0.75, 6);
    expect(stepAlpha(0.9, 1, 1, 0.2, 0.4)).toBe(1);
    expect(stepAlpha(0.1, 0, 1, 0.2, 0.4)).toBe(0);
    expect(stepAlpha(0.5, 0.5, 0.1, 0.2, 0.4)).toBe(0.5);
  });

  it('smoothTo is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 10; i++) a = smoothTo(a, 1, 0.01, 0.1);
    const b = smoothTo(0, 1, 0.1, 0.1);
    expect(a).toBeCloseTo(b, 6);
  });

  it('wobbleAt is bounded by the amplitude and matches the shader formula at a sample point', () => {
    const o = new Float32Array(2);
    wobbleAt(10, -20, 3, 0.55, o);
    const t = 3;
    const ex = 0.55 * (Math.sin(10 * 0.043 + t * 0.53) + Math.sin(-20 * 0.057 - t * 0.41 + 1.3) + 0.5 * Math.sin(-10 * 0.13 + t * 0.9));
    expect(o[0]).toBeCloseTo(ex, 5);
    for (let i = 0; i < 200; i++) {
      wobbleAt(i * 7.3, i * -3.1, i * 0.37, 0.55, o);
      expect(Math.abs(o[0])).toBeLessThanOrEqual(0.55 * 2.5 + 1e-6);
      expect(Math.abs(o[1])).toBeLessThanOrEqual(0.55 * 2.5 + 1e-6);
    }
  });
});

describe('LabelPlanner', () => {
  const rect = (pl: LabelPlanner, p: number) => {
    const c = pl.outCand[p];
    return { x: pl.outX[p], y: pl.outY[p], w: pl.w[c], h: pl.h[c], key: pl.key[c] };
  };
  const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('slot offsets place the box on the expected side of the anchor', () => {
    const o = new Float32Array(2);
    slotOffset(0, 40, 12, 5, o);
    expect(o[0]).toBe(5);
    slotOffset(1, 40, 12, 5, o);
    expect(o[0]).toBe(-45);
    slotOffset(2, 40, 12, 5, o);
    expect(o[1]).toBe(-17);
    slotOffset(3, 40, 12, 5, o);
    expect(o[1]).toBe(5);
  });

  it('never returns overlapping rectangles, even for densely packed anchors', () => {
    const pl = new LabelPlanner(512, 128);
    for (let i = 0; i < 300; i++) pl.add(i, 100 - i * 0.1, 100 + (i % 20) * 20, 100 + Math.floor(i / 20) * 9, 60, 13, 5, 0);
    pl.plan(100, 0, 0, 800, 600, 2);
    expect(pl.placed).toBeGreaterThan(5);
    expect(pl.placed).toBeLessThanOrEqual(100);
    for (let i = 0; i < pl.placed; i++) for (let j = i + 1; j < pl.placed; j++) expect(overlap(rect(pl, i), rect(pl, j))).toBe(false);
  });

  it('gives the slot to the higher score and falls back to another side', () => {
    const pl = new LabelPlanner(8, 8);
    pl.add(1, 10, 100, 100, 50, 12, 5, 0);
    pl.add(2, 90, 100, 100, 50, 12, 5, 0); // same anchor, higher score: gets the preferred right slot
    pl.plan(8, 0, 0, 400, 400, 2);
    expect(pl.placed).toBe(2);
    expect(pl.key[pl.outCand[0]]).toBe(2);
    expect(pl.outSlot[0]).toBe(0);
    expect(pl.outSlot[1]).not.toBe(0);
    expect(overlap(rect(pl, 0), rect(pl, 1))).toBe(false);
  });

  it('honours the label cap, bounds, obstacles, and always places pinned candidates', () => {
    const pl = new LabelPlanner(64, 32);
    for (let i = 0; i < 20; i++) pl.add(i, 50 - i, 30 + i * 70, 200, 40, 12, 4, 0);
    pl.add(99, PIN_SCORE, 300, 200, 40, 12, 4, 0);
    pl.plan(3, 0, 0, 1000, 400, 2);
    const keys = Array.from({ length: pl.placed }, (_, p) => pl.key[pl.outCand[p]]);
    expect(keys[0]).toBe(99);
    expect(pl.placed).toBe(4); // 3 normal + the pin
    // bounds: an anchor at the left edge cannot place on the left; it must pick a slot inside
    pl.reset();
    pl.add(1, 10, 2, 100, 40, 12, 4, 1);
    pl.plan(5, 0, 0, 400, 400, 2);
    expect(pl.outX[0]).toBeGreaterThanOrEqual(0);
    // obstacle: the only free side is used
    pl.reset();
    pl.obstacles.push(100, 90, 200, 20);
    pl.add(1, 10, 80, 100, 40, 12, 4, 0);
    pl.plan(5, 0, 0, 400, 400, 2);
    if (pl.placed > 0) {
      const r = rect(pl, 0);
      expect(r.x < 300 && r.x + r.w > 100 && r.y < 110 && r.y + r.h > 90).toBe(false);
    }
    pl.obstacles.length = 0;
  });

  it('is deterministic for equal scores (ties broken by key) and stable across calls', () => {
    const run = () => {
      const pl = new LabelPlanner(64, 64);
      for (let i = 0; i < 30; i++) pl.add(30 - i, 5, 100 + (i % 3) * 10, 100, 50, 12, 4, 0);
      pl.plan(64, 0, 0, 600, 600, 2);
      return Array.from({ length: pl.placed }, (_, p) => `${pl.key[pl.outCand[p]]}:${pl.outSlot[p]}`).join(',');
    };
    expect(run()).toBe(run());
    expect(SLOT_COUNT).toBe(8);
  });
});

describe('LabelModel (id replica)', () => {
  it('assigns the same node ids as the simulation and tracks last-touching commits', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    for (let i = 0; i < fixture.length * 45 + 10; i++) sim.step();
    const m = new LabelModel();
    m.setCommits(fixture);
    m.sync(sim.commitIndex, 100);
    expect(m.tree.nodes.length).toBe(sim.tree.nodes.length);
    for (let id = 0; id < sim.tree.nodes.length; id++) {
      expect(m.tree.nodes[id].path).toBe(sim.tree.nodes[id].path);
      expect(m.tree.nodes[id].alive).toBe(sim.tree.nodes[id].alive);
    }
    const last = fixture[fixture.length - 1].files[0].path;
    const id = m.tree.lookup(last);
    expect(m.lastCommit[id]).toBeGreaterThanOrEqual(0);
  });

  it('stamps live touches only for small forward steps, and rewinds correctly', () => {
    const m = new LabelModel();
    m.setCommits(fixture);
    m.sync(0, 10);
    const first = fixture[0].files[0].path;
    const id = m.tree.lookup(first);
    expect(m.touchedAt[id]).toBe(10);
    m.sync(fixture.length - 1, 20); // big jump: only the final commit is "live"
    const lastCommitFiles = fixture[fixture.length - 1].files.map((f) => m.tree.lookup(f.path)).filter((i) => i >= 0);
    for (const i of lastCommitFiles) expect(m.touchedAt[i]).toBe(20);
    expect(m.touchedAt[id]).toBe(10);
    m.sync(0, 30); // seek back: replay from scratch
    expect(m.applied).toBe(0);
    expect(m.tree.nodes.length).toBeLessThan(fixture.length * 10);
    expect(m.touchedAt[m.tree.lookup(first)]).toBe(30);
  });

  it('maps the float32 pulse hue back to the author', () => {
    const m = new LabelModel();
    m.setCommits(fixture);
    for (let i = 0; i < m.authors.length; i++) {
      expect(m.hueIndex.get(Math.fround(authorHue(m.authors[i])))).toBe(i);
    }
  });
});
