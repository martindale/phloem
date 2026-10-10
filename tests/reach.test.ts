// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LabelModel } from '../src/labels/model';
import { ReachTracker, isReached } from '../src/labels/reach';
import { parseCommitEvents } from '../src/model/parse';
import { NodeKind } from '../src/model/tree';
import { Simulation } from '../src/sim/engine';
import { A, ANCHOR_STRIDE, H, anchorOffset } from '../src/sim/frame';

const fixture = parseCommitEvents(JSON.parse(readFileSync(new URL('../fixtures/stemdeck-first10.json', import.meta.url), 'utf8')));

function snap(sim: Simulation) {
  const f = new Float32Array(sim.packCapacity());
  sim.pack(f);
  const n = f[H.anchors] | 0;
  const o = anchorOffset(f);
  const out: { id: number; reached: boolean }[] = [];
  for (let i = 0; i < n; i++) out.push({ id: f[o + i * ANCHOR_STRIDE + A.id] | 0, reached: isReached(f[o + i * ANCHOR_STRIDE + A.reached]) });
  return { commit: f[H.commit], anchors: out };
}

/** What the label layer is allowed to name for a frame: reached anchors, names resolved through the replica. */
function nameable(model: LabelModel, s: ReturnType<typeof snap>): string[] {
  model.sync(s.commit, 0);
  return s.anchors.filter((a) => isReached(a.reached ? 1 : 0)).map((a) => model.tree.nodes[a.id].name);
}

describe('reached gating', () => {
  it('isReached thresholds the anchor flag', () => {
    expect(isReached(0)).toBe(false);
    expect(isReached(1)).toBe(true);
  });

  it('ReachTracker reports only the rising edge, and forgets on a backward seek', () => {
    const t = new ReachTracker();
    t.begin(0);
    expect(t.step(3, false)).toBe(false);
    expect(t.step(3, true)).toBe(true);
    expect(t.step(3, true)).toBe(false);
    t.begin(5);
    t.begin(2); // seek back
    expect(t.step(3, true)).toBe(true);
    t.step(5000, true); // grows
    expect(t.step(5000, true)).toBe(false);
  });

  it('regression: right after a commit lands its new files exist as anchors but are unreached (labels must not name them)', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    const model = new LabelModel();
    model.setCommits(fixture);
    let sawEarly = false;
    for (let t = 0; t < 400 && !sawEarly; t++) {
      sim.step();
      const s = snap(sim);
      const early = s.anchors.filter((a) => !a.reached);
      if (early.length > 0) {
        sawEarly = true;
        model.sync(s.commit, 0);
        const names = nameable(model, s);
        for (const a of early) {
          const node = model.tree.nodes[a.id];
          expect(node.kind === NodeKind.File || node.kind === NodeKind.Folder).toBe(true);
          expect(names.includes(node.name) && s.anchors.some((b) => b.reached && model.tree.nodes[b.id].name === node.name)).toBe(false);
        }
      }
    }
    expect(sawEarly).toBe(true);
  });

  it('at the very start nothing but the root is reached', () => {
    const sim = new Simulation(fixture, { seed: 1 });
    const s = snap(sim);
    expect(s.anchors.filter((a) => a.reached).every((a) => a.id === 0)).toBe(true);
  });

  it('the reached set is deterministic: a second run to the same tick (what a seek does) shows the same names', () => {
    const a = new Simulation(fixture, { seed: 7 });
    const b = new Simulation(fixture, { seed: 7 });
    for (let t = 0; t < 300; t++) {
      a.step();
      b.step();
    }
    const ids = (s: Simulation) => snap(s).anchors.filter((x) => x.reached).map((x) => x.id).sort();
    expect(ids(b)).toEqual(ids(a));
    expect(ids(a).length).toBeGreaterThan(1);
  });
});
