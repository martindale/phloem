// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { floodDuration } from '../src/sim/activity';
import { H, HEADER } from '../src/sim/frame';
import {
  DIRECTOR, Director, burstDrive, clearDistance, createSignals, readSignals, smoothstep, type Pose, type Signals,
} from '../src/render/director';
import { parseViewerParams, patchSearch, stateToPatch } from '../src/web/urlstate';

const FIT = 400;

function sig(over: Partial<Signals> = {}): Signals {
  const s = createSignals();
  Object.assign(s, {
    valid: true, tick: 1000, commit: 20, playing: true,
    minX: -250, maxX: 250, minY: -150, maxY: 150, minZ: -80, maxZ: 80,
    reach: 400,
  }, over);
  return s;
}
function pose(over: Partial<Pose> = {}): Pose {
  return { tx: 0, ty: 0, tz: 0, dist: FIT, yaw: -0.55, pitch: 0.38, ...over };
}
function on(): Director {
  const d = new Director();
  d.setEnabled(true);
  return d;
}
/** Run `secs` of frames at `dt`; `at(t, step)` may mutate the signals. Returns the max per-frame target / log-dist movement. */
function run(d: Director, p: Pose, s: Signals, secs: number, dt = 1 / 60, at?: (t: number) => void, fit = FIT) {
  let maxMove = 0;
  let maxLog = 0;
  for (let t = 0; t < secs; t += dt) {
    at?.(t);
    const b = { ...p };
    d.step(dt, s, p, fit);
    maxMove = Math.max(maxMove, Math.hypot(p.tx - b.tx, p.ty - b.ty, p.tz - b.tz) / dt);
    maxLog = Math.max(maxLog, Math.abs(Math.log(p.dist / b.dist)) / dt);
  }
  return { maxMove, maxLog };
}

describe('director math', () => {
  it('smoothstep clamps and is smooth at the ends', () => {
    expect(smoothstep(0.1, 0.5, 0)).toBe(0);
    expect(smoothstep(0.1, 0.5, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('burstDrive: big commits drive hard, small ones barely, and it fades out with the flood', () => {
    const big = [1000, 0.99, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const small = [1000, 0.14, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(burstDrive(1000, big, 400)).toBeGreaterThan(0.95);
    expect(burstDrive(1000, small, 400)).toBeLessThan(0.1);
    const life = floodDuration(400);
    expect(burstDrive(1000 + life * 0.3, big, 400)).toBeGreaterThan(0.95); // still flooding
    const late = burstDrive(1000 + life * 1.0, big, 400);
    expect(late).toBeLessThan(0.6);
    expect(late).toBeGreaterThan(0);
    expect(burstDrive(1000 + life * 1.5, big, 400)).toBe(0);
    expect(burstDrive(900, big, 400)).toBe(0); // not landed yet (seeked back)
    expect(burstDrive(1000, new Float32Array(12), 400)).toBe(0);
  });

  it('clearDistance pushes an eye out of the solid ellipsoid and leaves outside eyes alone', () => {
    // target at the centre, looking along +z: leave through the far side at e_z
    expect(clearDistance(0, 0, 0, 100, 100, 50, 0, 0, 0, 0, 0, 1, 20, 5)).toBeCloseTo(50, 6);
    expect(clearDistance(0, 0, 0, 100, 100, 50, 0, 0, 0, 0, 0, 1, 80, 5)).toBe(80);
    // target outside, ray misses
    expect(clearDistance(0, 0, 0, 100, 100, 50, 500, 0, 0, 0, 0, 1, 80, 5)).toBe(80);
    // target outside, ray pointing away
    expect(clearDistance(0, 0, 0, 100, 100, 50, 500, 0, 0, 1, 0, 0, 80, 5)).toBe(80);
    // ray crosses the ellipsoid: eye inside the crossing snaps to the nearer boundary
    const s = clearDistance(0, 0, 0, 100, 100, 100, 300, 0, 0, -1, 0, 0, 230, 5);
    expect(s).toBeCloseTo(200, 6);
    const far = clearDistance(0, 0, 0, 100, 100, 100, 300, 0, 0, -1, 0, 0, 370, 5);
    expect(far).toBeCloseTo(400, 6);
    expect(clearDistance(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 20, 5)).toBe(20); // degenerate axes: no change, no NaN
  });

  it('readSignals follows the header layout', () => {
    const h = new Float32Array(HEADER);
    h[H.tick] = 77; h[H.commit] = 3; h[H.segs] = 10; h[H.playing] = 1;
    h[H.minX] = -5; h[H.maxZ] = 9; h[H.hotX] = 1.5; h[H.hotW] = 4; h[H.hotR] = 12; h[H.activity] = 0.4; h[H.reach] = 300;
    h[H.bursts] = 70; h[H.bursts + 1] = 0.9; h[H.bursts + 2] = 0.2;
    const s = readSignals(h, createSignals());
    expect(s).toMatchObject({ valid: true, tick: 77, commit: 3, playing: true, minX: -5, maxZ: 9, hotX: 1.5, hotW: 4, hotR: 12, reach: 300 });
    expect(s.activity).toBeCloseTo(0.4, 5);
    expect(Array.from(s.bursts.slice(0, 3))).toEqual([70, expect.closeTo(0.9, 5), expect.closeTo(0.2, 5)]);
    h[H.segs] = 0;
    expect(readSignals(h, s).valid).toBe(false);
  });
});

describe('director shots', () => {
  it('does nothing when off, before the first frame, or with an empty mold', () => {
    const p = pose();
    const q = { ...p };
    const off = new Director();
    run(off, p, sig(), 2);
    expect(p).toEqual(q);
    const d = on();
    run(d, p, sig({ valid: false }), 2);
    expect(p).toEqual(q);
    expect(d.state).toBe('standby');
  });

  it('establishing shot when nothing happens: whole mold, centre target, slight push-in over calm time', () => {
    const d = on();
    const p = pose({ tx: 90, ty: -40, dist: 150 });
    run(d, p, sig({ minX: -100, maxX: 300, activity: 0, hotW: 0 }), 40);
    expect(p.tx).toBeCloseTo(100, 0);
    expect(p.ty).toBeCloseTo(0, 0);
    expect(p.dist).toBeGreaterThan(FIT * 0.85);
    expect(p.dist).toBeLessThanOrEqual(FIT * 1.01);
    expect(d.follow).toBeLessThan(0.01);
  });

  it('follows the hot-spot and tightens the shot when there is steady activity', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 180, hotY: 60, hotZ: 10, hotR: 25 });
    run(d, p, s, 20, 1 / 60, () => (s.tick += 1));
    expect(d.follow).toBeGreaterThan(0.9);
    expect(p.tx).toBeGreaterThan(150);
    expect(p.tx).toBeLessThanOrEqual(180.5);
    expect(p.ty).toBeGreaterThan(45);
    expect(p.dist).toBeLessThan(FIT * 0.6);
    expect(p.dist).toBeGreaterThan(DIRECTOR.FOLLOW_MIN * FIT * 0.85);
  });

  it('weights by activity: a hot-spot with no activity does not move the camera', () => {
    const d = on();
    const p = pose();
    run(d, p, sig({ activity: 0.02, hotW: 0.5, hotX: 200, hotR: 10 }), 20);
    expect(Math.abs(p.tx)).toBeLessThan(5);
    expect(p.dist).toBeGreaterThan(FIT * 0.85);
  });

  it('a big commit pulls back and widens; the follow shot returns after the flood', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.8, hotW: 18, hotX: 150, hotY: 40, hotR: 30, tick: 5000 });
    const burstTick = 5000 + 8 * 60;
    let before = 0;
    let during = 0;
    let after = 0;
    run(d, p, s, 20, 1 / 60, (t) => {
      s.tick = 5000 + Math.round(t * 60);
      if (s.tick >= burstTick) {
        s.bursts[0] = burstTick;
        s.bursts[1] = 0.99;
      }
      if (Math.abs(t - 7.9) < 1 / 120) before = p.dist;
      if (t > 8 && t < 14) during = Math.max(during, p.dist);
      if (Math.abs(t - 19.9) < 1 / 120) after = p.dist;
    });
    expect(before).toBeLessThan(FIT * 0.6);
    expect(during).toBeGreaterThan(before * 1.5);
    expect(during).toBeGreaterThan(FIT * 0.85);
    expect(after).toBeLessThan(during * 0.8);
    // a one-file commit hardly matters
    const d2 = on();
    const p2 = pose();
    const s2 = sig({ activity: 0.8, hotW: 18, hotX: 150, hotR: 30 });
    s2.bursts[0] = 1000; s2.bursts[1] = 0.14;
    run(d2, p2, s2, 20);
    expect(p2.dist).toBeLessThan(FIT * 0.6);
  });

  it('paused playback relaxes to the establishing shot and drifts slower', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 180, hotR: 25 });
    run(d, p, s, 15);
    expect(d.follow).toBeGreaterThan(0.8);
    const y0 = p.yaw;
    s.playing = false;
    run(d, p, s, 15);
    expect(d.follow).toBeLessThan(0.05);
    expect(Math.abs(p.tx)).toBeLessThan(15);
    // while paused the azimuth still creeps, at a fraction of the playing rate
    const y1 = p.yaw;
    run(d, p, s, 10);
    const pausedRate = (p.yaw - y1) / 10;
    expect(pausedRate).toBeGreaterThan(0);
    expect(pausedRate).toBeLessThan(DIRECTOR.YAW_RATE * 0.6);
    expect(y1).toBeGreaterThan(y0);
  });

  it('tiny / degenerate molds stay finite and sane', () => {
    const d = on();
    const p = pose({ dist: 100 });
    const s = sig({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0, activity: 1, hotW: 3, hotX: 0, hotY: 0, hotZ: 0, hotR: 0 });
    run(d, p, s, 20, 1 / 60, undefined, 40);
    for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
    expect(p.dist).toBeGreaterThanOrEqual(10);
    expect(p.dist).toBeLessThan(200);
  });
});

describe('director motion limits', () => {
  it('yaw rate and elevation stay within the cinematic caps; pitch stays in range', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.8, hotW: 20, hotX: 120, hotR: 30 });
    let maxYaw = 0;
    let minP = 9;
    let maxP = -9;
    for (let i = 0; i < 60 * 200; i++) {
      s.tick += 1;
      if (i % 700 === 300) {
        s.bursts[0] = s.tick;
        s.bursts[1] = 0.95;
      }
      const y = p.yaw;
      d.step(1 / 60, s, p, FIT);
      maxYaw = Math.max(maxYaw, ((p.yaw - y) * 60));
      minP = Math.min(minP, p.pitch);
      maxP = Math.max(maxP, p.pitch);
    }
    expect(maxYaw).toBeLessThanOrEqual(DIRECTOR.MAX_YAW_RATE + 1e-9);
    expect(maxYaw).toBeGreaterThan(0.02);
    expect(minP).toBeGreaterThan(0.2);
    expect(maxP).toBeLessThan(0.7);
  });

  it('never puts the eye inside the solid part of the mold', () => {
    const d = on();
    const p = pose({ dist: 60, tx: 10, ty: 5 });
    const s = sig({ activity: 1, hotW: 30, hotR: 5, hotX: 0, hotY: 0, hotZ: 0 });
    const hot = [[0, 0, 0], [200, 100, 40], [-220, -100, -30], [0, 120, 0]];
    for (let i = 0; i < 60 * 240; i++) {
      s.tick += 1;
      const k = Math.floor(i / 900) % hot.length;
      [s.hotX, s.hotY, s.hotZ] = hot[k];
      d.step(1 / 60, s, p, FIT);
      const cp = Math.cos(p.pitch);
      const ex = p.tx + p.dist * cp * Math.sin(p.yaw);
      const ey = p.ty + p.dist * Math.sin(p.pitch);
      const ez = p.tz + p.dist * cp * Math.cos(p.yaw);
      const q = (ex / 250) ** 2 + (ey / 150) ** 2 + (ez / 80) ** 2;
      expect(q).toBeGreaterThan(DIRECTOR.SOLID ** 2 * 0.98);
      expect(p.dist).toBeGreaterThanOrEqual(10);
    }
  });

  it('reduced motion: slower azimuth and target speed', () => {
    const fast = on();
    const slow = on();
    slow.reduced = true;
    const pf = pose();
    const ps = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 200, hotR: 20 });
    const y0 = pf.yaw;
    const rf = run(fast, pf, s, 12);
    const rs = run(slow, ps, s, 12);
    expect(ps.yaw - y0).toBeLessThan((pf.yaw - y0) * 0.5);
    expect(rs.maxMove).toBeLessThan(rf.maxMove * 0.6);
    expect(slow.yawRate).toBeLessThanOrEqual(DIRECTOR.MAX_YAW_RATE * DIRECTOR.REDUCED + 1e-12);
  });
});

describe('hand-off to the user and back', () => {
  it('user input stops the director quickly and smoothly; it resumes by itself after the idle delay', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 180, hotR: 25 });
    run(d, p, s, 10);
    expect(d.state).toBe('directing');
    expect(d.authority).toBe(1);
    // the user grabs the camera
    d.input();
    expect(d.state).toBe('user');
    const speeds: number[] = [];
    for (let i = 0; i < 90; i++) {
      const b = { ...p };
      d.step(1 / 60, s, p, FIT);
      speeds.push(Math.hypot(p.tx - b.tx, p.ty - b.ty, p.tz - b.tz) + Math.abs(p.yaw - b.yaw) * 100 + Math.abs(p.dist - b.dist));
    }
    expect(d.authority).toBe(0);
    // no jerk: the motion decays monotonically-ish (never jumps up) and is gone after 0.5 s
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1] * 1.05 + 1e-9);
    expect(speeds[60]).toBeLessThan(1e-3);
    // while the user keeps interacting (input every 0.5 s) the camera is not touched
    const frozen = { ...p };
    for (let i = 0; i < 60 * 12; i++) {
      if (i % 30 === 0) d.input();
      d.step(1 / 60, s, p, FIT);
    }
    expect(p).toEqual(frozen);
    // quiet: back in after RESUME_DELAY, from rest (first frames barely move)
    let resumedAt = -1;
    const first: number[] = [];
    for (let i = 0; i < 60 * 10; i++) {
      const b = { ...p };
      d.step(1 / 60, s, p, FIT);
      if (resumedAt < 0 && d.authority > 0) {
        resumedAt = i / 60;
        first.length = 0;
      }
      if (resumedAt >= 0 && first.length < 10) first.push(Math.hypot(p.tx - b.tx, p.ty - b.ty, p.tz - b.tz) + Math.abs(p.dist - b.dist));
    }
    expect(resumedAt).toBeGreaterThan(DIRECTOR.RESUME_DELAY - 0.6);
    expect(resumedAt).toBeLessThan(DIRECTOR.RESUME_DELAY + 0.1);
    expect(Math.max(...first)).toBeLessThan(0.2);
    expect(d.authority).toBeGreaterThan(0.9);
    expect(d.state).toBe('directing');
  });

  it('a held pointer keeps the camera with the user however long it is held', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 180, hotR: 25 });
    d.held = true;
    const q = { ...p };
    run(d, p, s, 30);
    expect(p).toEqual(q);
    expect(d.state).toBe('user');
    d.held = false;
    d.input();
    run(d, p, s, DIRECTOR.RESUME_DELAY + 3);
    expect(p.tx).not.toBe(q.tx);
  });

  it('turning the mode off releases at once, on again takes over immediately', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 180, hotR: 25 });
    run(d, p, s, 5);
    d.setEnabled(false);
    const q = { ...p };
    run(d, p, s, 2);
    expect(p).toEqual(q);
    expect(d.state).toBe('off');
    d.setEnabled(true);
    run(d, p, s, 1);
    expect(p).not.toEqual(q);
  });
});

describe('seeking, determinism, frame rate', () => {
  it('a seek (tick jump or the seeking flag) glides to the new establishing shot at limited speed', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 180, hotR: 25, tick: 20000 });
    run(d, p, s, 10, 1 / 60, () => (s.tick += 1));
    expect(d.follow).toBeGreaterThan(0.8);
    // seek back to a tiny early mold
    Object.assign(s, { tick: 300, minX: -40, maxX: 40, minY: -30, maxY: 30, minZ: -15, maxZ: 15, hotX: -30, hotW: 8, activity: 0.7, hotR: 8 });
    const r0 = run(d, p, s, 0.5, 1 / 60, () => (s.tick += 1), 150);
    expect(d.follow).toBeLessThan(0.2); // the follow shot is held off right after a jump
    const r = run(d, p, s, 11.5, 1 / 60, () => (s.tick += 1), 150);
    r.maxMove = Math.max(r.maxMove, r0.maxMove);
    r.maxLog = Math.max(r.maxLog, r0.maxLog);
    // speed limits hold through the jump (target <= 22 % of the distance per second, log-distance <= 0.45/s)
    expect(r.maxMove).toBeLessThanOrEqual(DIRECTOR.MAX_TARGET_SPEED * 420 + 1e-6);
    expect(r.maxLog).toBeLessThanOrEqual(DIRECTOR.MAX_LOGDIST_RATE + 1e-6);
    // settles on the new mold within the run
    expect(Math.abs(p.tx)).toBeLessThan(35);
    expect(p.dist).toBeLessThan(200);
    expect(d.follow).toBeGreaterThan(0.5); // and picks the action up again once the filters have refilled
  });

  it('the seeking flag alone clears the activity filters', () => {
    const d = on();
    const p = pose();
    const s = sig({ activity: 0.9, hotW: 20, hotX: 180, hotR: 25 });
    run(d, p, s, 10);
    s.seeking = true;
    d.step(1 / 60, s, p, FIT);
    expect(d.act).toBe(0);
    expect(d.burst).toBe(0);
  });

  it('is deterministic for the same frame stream', () => {
    const trace = () => {
      const d = on();
      const p = pose();
      const s = sig({ activity: 0.7, hotW: 12, hotX: 100, hotR: 20 });
      const out: number[] = [];
      run(d, p, s, 30, 1 / 60, (t) => {
        s.tick += 1;
        s.hotX = 100 + 80 * Math.sin(t * 0.7);
        if (Math.round(t * 60) === 600) { s.bursts[0] = s.tick; s.bursts[1] = 0.99; }
        if (Math.round(t * 60) % 60 === 0) out.push(p.tx, p.ty, p.tz, p.dist, p.yaw, p.pitch);
      });
      return out;
    };
    expect(trace()).toEqual(trace());
  });

  it('is frame-rate independent for the same signals (30, 60 and 144 fps agree)', () => {
    const final = (dt: number) => {
      const d = on();
      const p = pose();
      const s = sig({ activity: 0.9, hotW: 20, hotX: 150, hotY: 30, hotR: 25 });
      run(d, p, s, 12, dt);
      return p;
    };
    const a = final(1 / 30);
    const b = final(1 / 60);
    const c = final(1 / 144);
    for (const o of [a, c]) {
      expect(Math.abs(o.tx - b.tx)).toBeLessThan(6);
      expect(Math.abs(o.dist / b.dist - 1)).toBeLessThan(0.04);
      expect(Math.abs(o.yaw - b.yaw)).toBeLessThan(0.03);
      expect(Math.abs(o.pitch - b.pitch)).toBeLessThan(0.02);
    }
  });
});

describe('retired ?director / ?orbit parameters', () => {
  it('the camera director is always on: the URL no longer carries a switch, and old links are cleaned', () => {
    expect(parseViewerParams('?demo&director=0')).not.toHaveProperty('director');
    expect(parseViewerParams('?demo&orbit')).not.toHaveProperty('orbit');
    expect(patchSearch('?demo&orbit&director', stateToPatch({ speed: 2 }))).toBe('?demo&speed=2');
    expect(patchSearch('?demo&director=0', stateToPatch({ labels: 'off' }))).toBe('?demo&labels=off');
  });
});
