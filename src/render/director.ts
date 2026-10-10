// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Auto-director: a cinematic camera mode that drives the orbit camera from the frame header's activity signals
 * (`H.hotX/Y/Z`, `hotW`, `hotR`, `activity`, `bursts`, `reach`, bbox; see sim/activity.ts and docs/ARCHITECTURE.md).
 *
 * Pure logic: no DOM, no WebGL, no Math.random, no wall clock. The only inputs are the per-frame `Signals`, the real frame
 * time `dt`, the camera pose it moves (a structural `Pose`) and the camera's own "fit the whole mold" distance, so the same
 * frame stream and dt sequence gives the same camera path (tested in tests/director.test.ts).
 *
 * Shot logic
 *   establishing : target = bbox centre, distance = camera auto-fit (whole mold in frame).
 *   follow       : target eases toward the activity hot-spot, distance toward ~5 x the activity radius.
 *   blend        : followW = smoothstep(activity); the raw per-frame signals are low-passed first (tau ~1-3 s), activity
 *                  rising faster than it falls so a shot does not flicker between commits.
 *   big commit   : burst energy (shaped by how far its flood has travelled) pulls back to the establishing shot, widens a
 *                  further 12 %, lifts the elevation a little and re-centres the target.
 *   calm growth  : `calm` creeps up with a ~25 s time constant while nothing big lands and eases the shots in by up to
 *                  12 %; any big burst drops it quickly.
 *   orbit        : a slow azimuth drift (~2-3.4 deg/s, modulated by a 53 s sine, max `MAX_YAW_RATE`), an elevation sine
 *                  (+-0.09 rad, 43 s) and nothing else: no roll (the camera has none), no cuts.
 *   safety       : the eye is kept outside an ellipsoid inscribed in the bbox (`clearDistance`), the distance stays within
 *                  [dMin, dMax] and every motion is a critically damped spring with a speed limit.
 *
 * Hand-off: `input()` (any pointer / wheel / touch / reset) drops `authority` (the fraction of time the springs run at) to 0
 * within ~0.2 s, so the camera glides to a stop rather than snapping, then it stays with the user. After `RESUME_DELAY` s
 * without input (and with no pointer held) authority rises again over ~1.2 s from rest, so the director eases in.
 * Seeks (the seeking flag, a tick going backwards or jumping forward) clear the activity filters and hold the follow shot
 * off for `SEEK_HOLD` s; the springs then carry the camera to the new establishing shot at limited speed (no whiplash).
 */
import { floodDuration } from '../sim/activity';
import { BURST_STRIDE, H } from '../sim/frame';

/** Tunables. Times in seconds, angles in radians, rates per second. */
export const DIRECTOR = {
  /** Seconds without input before the director takes the camera back. */
  RESUME_DELAY: 6,
  /** Authority fall (user took over) and rise (director resumes) time constants. */
  AUTH_OUT_TAU: 0.18,
  AUTH_IN_TAU: 1.2,
  /** Signal low-pass time constants. */
  ACT_RISE_TAU: 1.2,
  ACT_FALL_TAU: 2.5,
  BURST_RISE_TAU: 0.5,
  BURST_FALL_TAU: 3,
  HOT_TAU: 1.6,
  RADIUS_TAU: 2.0,
  CALM_UP_TAU: 25,
  CALM_DOWN_TAU: 3,
  /** Seconds the follow shot is held off after a seek / first frame (gain ramps 0 -> 1 over it). */
  SEEK_HOLD: 2,
  /** A tick delta beyond this between two frames is a jump (normal playback is <= 3 x speed per frame). */
  JUMP_TICKS: 400,
  /** Spring natural frequencies (rad/s): target, log distance, elevation. */
  W_TARGET: 0.9,
  W_DIST: 1.2,
  W_PITCH: 1.0,
  /** Speed limits: target in distance-fractions per second, log-distance per second. */
  MAX_TARGET_SPEED: 0.22,
  MAX_LOGDIST_RATE: 0.6,
  /** Azimuth drift (rad/s): mean rate, hard cap, and the share kept while paused. */
  YAW_RATE: 0.05,
  MAX_YAW_RATE: 0.075,
  YAW_TAU: 1.5,
  PAUSED_SPIN: 0.35,
  /** Elevation: mean, sine amplitude, extra lift at full burst, clamp. */
  PITCH_MEAN: 0.36,
  PITCH_AMP: 0.09,
  PITCH_BURST: 0.1,
  PITCH_MIN: 0.15,
  PITCH_MAX: 0.9,
  /** Shot sizes. */
  FOLLOW_R_MUL: 3.6,
  FOLLOW_R_ADD: 16,
  FOLLOW_MIN: 0.42,
  FOLLOW_MAX: 0.95,
  CALM_PUSH: 0.12,
  BURST_WIDEN: 0.12,
  /** Share of the bbox half extents that counts as solid for `clearDistance`. */
  SOLID: 0.8,
  /** Everything slower and softer under prefers-reduced-motion. */
  REDUCED: 0.35,
} as const;

const TWO_PI = Math.PI * 2;

/** The camera state the director moves (render/camera.ts `Camera` satisfies it). */
export interface Pose {
  tx: number;
  ty: number;
  tz: number;
  dist: number;
  yaw: number;
  pitch: number;
}

/** The parts of the frame header the director reads. */
export interface Signals {
  /** A frame with geometry has arrived (commit >= 0 and segments > 0). */
  valid: boolean;
  tick: number;
  commit: number;
  playing: boolean;
  seeking: boolean;
  waiting: boolean;
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  hotX: number; hotY: number; hotZ: number; hotW: number; hotR: number;
  activity: number;
  reach: number;
  /** Up to 4 records of (landing tick, energy, hue), newest first (energy 0 = empty slot). */
  bursts: Float32Array;
}

export function createSignals(): Signals {
  return {
    valid: false, tick: 0, commit: -1, playing: false, seeking: false, waiting: false,
    minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
    hotX: 0, hotY: 0, hotZ: 0, hotW: 0, hotR: 0, activity: 0, reach: 0,
    bursts: new Float32Array(4 * BURST_STRIDE),
  };
}

/** Copy the relevant header fields (no allocation). */
export function readSignals(h: ArrayLike<number>, o: Signals): Signals {
  o.tick = h[H.tick];
  o.commit = h[H.commit];
  o.valid = o.commit >= 0 && h[H.segs] > 0;
  o.playing = h[H.playing] === 1;
  o.seeking = h[H.seeking] === 1;
  o.waiting = h[H.waiting] === 1;
  o.minX = h[H.minX]; o.minY = h[H.minY]; o.minZ = h[H.minZ];
  o.maxX = h[H.maxX]; o.maxY = h[H.maxY]; o.maxZ = h[H.maxZ];
  o.hotX = h[H.hotX]; o.hotY = h[H.hotY]; o.hotZ = h[H.hotZ];
  o.hotW = h[H.hotW]; o.hotR = h[H.hotR];
  o.activity = h[H.activity];
  o.reach = h[H.reach];
  for (let i = 0; i < o.bursts.length; i++) o.bursts[i] = h[H.bursts + i];
  return o;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

const lpk = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

/**
 * Pull-back drive 0..1 of the live bursts: a burst counts with energy^3 (a one-file fix 0.003, 15 files 0.17, the 142-file
 * commit 0.99) while its flood is running, and fades out over the last 40 % of the flood's life (`floodDuration(reach)` ticks).
 */
export function burstDrive(tick: number, bursts: ArrayLike<number>, reach: number): number {
  const life = floodDuration(reach);
  let best = 0;
  for (let k = 0; k * BURST_STRIDE + 1 < bursts.length; k++) {
    const energy = bursts[k * BURST_STRIDE + 1];
    if (!(energy > 0)) continue;
    const age = tick - bursts[k * BURST_STRIDE];
    if (age < 0 || age > life * 1.4) continue;
    const env = 1 - smoothstep(0.6, 1.4, age / life);
    const v = energy * energy * energy * env;
    if (v > best) best = v;
  }
  return best > 1 ? 1 : best;
}

/**
 * Distance from `target` along the unit direction b (target -> eye) at which the eye is outside the solid ellipsoid
 * (centre c, semi-axes e) if `d` would put it inside; `d` unchanged otherwise. When the target itself is inside the
 * ellipsoid the eye must leave it (the far root); when the ray merely crosses it, the nearer boundary wins
 * (unless that is closer than `dMin`).
 */
export function clearDistance(
  cx: number, cy: number, cz: number, ex: number, ey: number, ez: number,
  tx: number, ty: number, tz: number, bx: number, by: number, bz: number,
  d: number, dMin: number,
): number {
  if (!(ex > 0 && ey > 0 && ez > 0)) return d;
  const ox = (tx - cx) / ex;
  const oy = (ty - cy) / ey;
  const oz = (tz - cz) / ez;
  const ux = bx / ex;
  const uy = by / ey;
  const uz = bz / ez;
  const A = ux * ux + uy * uy + uz * uz;
  if (A < 1e-12) return d;
  const B = ux * ox + uy * oy + uz * oz;
  const C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - A * C;
  if (disc <= 0) return d;
  const sq = Math.sqrt(disc);
  const s1 = (-B - sq) / A;
  const s2 = (-B + sq) / A;
  if (s2 <= 0) return d;
  if (d <= s1 || d >= s2) return d;
  if (s1 <= 0) return s2;
  if (s1 >= dMin && d - s1 < s2 - d) return s1;
  return s2;
}

/** Critically damped spring on one scalar, with a speed limit. The position lives with the caller (the camera). */
class Spring {
  v = 0;
  step(x: number, g: number, w: number, dt: number, vmax: number): number {
    const e = Math.exp(-w * dt);
    const d = x - g;
    const t = this.v + w * d;
    let nx = g + (d + t * dt) * e;
    let nv = (this.v - w * t * dt) * e;
    if (nv > vmax) nv = vmax;
    else if (nv < -vmax) nv = -vmax;
    const mx = vmax * dt;
    const dx = nx - x;
    if (dx > mx) nx = x + mx;
    else if (dx < -mx) nx = x - mx;
    this.v = nv;
    return nx;
  }
}

export type DirectorState =
  /** Mode off. */
  | 'off'
  /** Mode on, the director has (or is taking) the camera. */
  | 'directing'
  /** Mode on, the user has the camera; the director waits for `RESUME_DELAY` s of quiet. */
  | 'user'
  /** Mode on, but nothing to direct yet (no frame / empty mold). */
  | 'standby';

export class Director {
  enabled = false;
  /** prefers-reduced-motion: all motion slowed and softened (see `DIRECTOR.REDUCED`). */
  reduced = false;
  /** A pointer is down on the canvas: the user has the camera whatever the idle time. */
  held = false;
  /** 0..1: how much of real time the springs run at. */
  authority = 0;
  /** Seconds since the last user input. */
  idle = 1e9;
  // ---- filtered signals (readable for tests / the debug overlay)
  act = 0;
  burst = 0;
  calm = 0;
  hotR = 0;
  hx = 0;
  hy = 0;
  hz = 0;
  /** Follow weight 0..1 of the last step (0 = establishing shot). */
  follow = 0;
  /** Goal pose of the last step. */
  goal = { tx: 0, ty: 0, tz: 0, dist: 300, yaw: 0, pitch: 0.38 };
  yawRate = 0;
  clock = 0;

  private hasHot = false;
  private lastTick = -1;
  private seekHold = 0;
  private sx = new Spring();
  private sy = new Spring();
  private sz = new Spring();
  private sd = new Spring();
  private sp = new Spring();

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.idle = 1e9;
    this.resetMotion();
  }

  /** Any user camera input (pointer down/move while dragging, wheel, touch, reset): the user has the camera. */
  input(): void {
    this.idle = 0;
  }

  get state(): DirectorState {
    if (!this.enabled) return 'off';
    if (this.idle < DIRECTOR.RESUME_DELAY || this.held) return 'user';
    return this.lastTick < 0 ? 'standby' : 'directing';
  }

  private resetMotion(): void {
    this.authority = 0;
    this.sx.v = this.sy.v = this.sz.v = this.sd.v = this.sp.v = 0;
    this.yawRate = 0;
  }

  /**
   * Advance one frame. `fitDist` is the camera's own "whole mold in frame" distance for its current orientation.
   * Moves `pose` in place when the director has authority.
   */
  step(dt: number, s: Signals, pose: Pose, fitDist: number): void {
    if (!this.enabled) return;
    const D = DIRECTOR;
    dt = dt > 0.25 ? 0.25 : dt > 0 ? dt : 0;
    this.idle += dt;
    if (!s.valid) {
      // loading / empty: nothing to direct; forget the stream so the first frame counts as a seek
      this.lastTick = -1;
      this.hasHot = false;
      this.authority = 0;
      this.resetMotion();
      return;
    }
    const slow = this.reduced ? D.REDUCED : 1;

    // ---- seek / jump detection
    const dTick = s.tick - this.lastTick;
    const jump = this.lastTick < 0 || s.seeking || dTick < 0 || dTick > D.JUMP_TICKS;
    this.lastTick = s.tick;
    if (jump) {
      this.seekHold = D.SEEK_HOLD;
      this.act = this.burst = 0;
      this.hasHot = false;
    } else if (this.seekHold > 0) this.seekHold = Math.max(0, this.seekHold - dt);
    const gain = smoothstep(0, 1, 1 - this.seekHold / D.SEEK_HOLD);

    // ---- bounds
    const cx = (s.minX + s.maxX) / 2;
    const cy = (s.minY + s.maxY) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    const ex = Math.max(s.maxX - s.minX, 60) / 2;
    const ey = Math.max(s.maxY - s.minY, 60) / 2;
    const ez = Math.max(s.maxZ - s.minZ, 30) / 2;
    const sr = Math.hypot(ex, ey, ez);

    // ---- filtered signals (weighted by activity and by the post-seek gain)
    const live = s.playing && !s.waiting;
    const actRaw = live ? Math.min(1, Math.max(0, s.activity)) * gain : 0;
    const burstRaw = live ? burstDrive(s.tick, s.bursts, s.reach) * gain : 0;
    this.act += (actRaw - this.act) * lpk(dt, actRaw > this.act ? D.ACT_RISE_TAU * (1 / slow) : D.ACT_FALL_TAU);
    this.burst += (burstRaw - this.burst) * lpk(dt, burstRaw > this.burst ? D.BURST_RISE_TAU : D.BURST_FALL_TAU);
    const calmTarget = live && this.burst < 0.2 ? 1 : 0;
    this.calm += (calmTarget - this.calm) * lpk(dt, calmTarget > this.calm ? D.CALM_UP_TAU : D.CALM_DOWN_TAU);
    if (s.hotW > 0) {
      if (!this.hasHot) {
        this.hasHot = true;
        this.hx = s.hotX;
        this.hy = s.hotY;
        this.hz = s.hotZ;
        this.hotR = s.hotR;
      } else {
        const k = lpk(dt, D.HOT_TAU / slow) * (s.hotW / (s.hotW + 3));
        this.hx += (s.hotX - this.hx) * k;
        this.hy += (s.hotY - this.hy) * k;
        this.hz += (s.hotZ - this.hz) * k;
        this.hotR += (s.hotR - this.hotR) * lpk(dt, D.RADIUS_TAU);
      }
    } else if (!this.hasHot) {
      this.hx = cx;
      this.hy = cy;
      this.hz = cz;
      this.hotR = sr * 0.3;
    }

    // ---- shot
    this.follow = smoothstep(0.06, 0.4, this.act) * (1 - Math.min(1, 1.25 * this.burst));
    const dEst = Math.max(fitDist, 20) * (1 - D.CALM_PUSH * this.calm);
    const dFollow = Math.min(Math.max(D.FOLLOW_R_MUL * this.hotR + D.FOLLOW_R_ADD, D.FOLLOW_MIN * dEst), D.FOLLOW_MAX * dEst);
    let dGoal = Math.exp(Math.log(dEst) + (Math.log(dFollow) - Math.log(dEst)) * this.follow) * (1 + D.BURST_WIDEN * this.burst);
    const dMin = Math.max(10, 0.18 * sr);
    const dMax = Math.max(dEst * 1.4, dMin * 2);
    dGoal = Math.min(Math.max(dGoal, dMin), dMax);
    const g = this.goal;
    const f = this.follow;
    // the hot-spot stays inside the bbox; bursts also draw the target back to the middle
    const hx = Math.min(Math.max(this.hx, s.minX), s.maxX);
    const hy = Math.min(Math.max(this.hy, s.minY), s.maxY);
    const hz = Math.min(Math.max(this.hz, s.minZ), s.maxZ);
    g.tx = cx + (hx - cx) * f;
    g.ty = cy + (hy - cy) * f;
    g.tz = cz + (hz - cz) * f;
    g.pitch = Math.min(
      Math.max(D.PITCH_MEAN + D.PITCH_AMP * Math.sin((TWO_PI * this.clock) / 43 + 1.1) * slow + D.PITCH_BURST * this.burst, D.PITCH_MIN),
      D.PITCH_MAX,
    );
    g.yaw = pose.yaw;
    {
      // keep the eye out of the mold: use the goal target with the camera's current orientation
      const cp = Math.cos(pose.pitch);
      dGoal = clearDistance(cx, cy, cz, ex * D.SOLID, ey * D.SOLID, ez * D.SOLID, g.tx, g.ty, g.tz,
        cp * Math.sin(pose.yaw), Math.sin(pose.pitch), cp * Math.cos(pose.yaw), dGoal, dMin);
    }
    g.dist = dGoal;

    // ---- authority (hand-off)
    const want = this.idle >= D.RESUME_DELAY && !this.held;
    if (want) this.authority += (1 - this.authority) * lpk(dt, D.AUTH_IN_TAU / slow);
    else this.authority *= Math.exp(-dt / D.AUTH_OUT_TAU);
    if (this.authority < 0.002) {
      this.authority = 0;
      this.resetMotion();
    }
    if (this.authority === 0) return;
    if (this.authority > 0.999) this.authority = 1;

    // ---- drive the camera. Authority dilates time for the springs, so a half-handed-over camera is still on a smooth path.
    const e = dt * this.authority;
    this.clock += e;
    const yawTarget =
      D.YAW_RATE * (0.7 + 0.5 * Math.sin((TWO_PI * this.clock) / 53 + 0.4)) * (live ? 1 : D.PAUSED_SPIN) * slow;
    this.yawRate += (yawTarget - this.yawRate) * lpk(dt, D.YAW_TAU);
    const maxYaw = D.MAX_YAW_RATE * slow;
    if (this.yawRate > maxYaw) this.yawRate = maxYaw;
    pose.yaw += this.yawRate * e;

    const wT = D.W_TARGET * slow;
    const vT = D.MAX_TARGET_SPEED * pose.dist * slow;
    pose.tx = this.sx.step(pose.tx, g.tx, wT, e, vT);
    pose.ty = this.sy.step(pose.ty, g.ty, wT, e, vT);
    pose.tz = this.sz.step(pose.tz, g.tz, wT, e, vT);
    pose.pitch = this.sp.step(pose.pitch, g.pitch, D.W_PITCH * slow, e, 0.12 * slow);
    const ld = this.sd.step(Math.log(pose.dist), Math.log(g.dist), D.W_DIST * slow, e, D.MAX_LOGDIST_RATE * slow);
    let dist = Math.exp(ld);
    // hard guard: whatever the springs lag, never sit inside the solid part of the mold
    const cp = Math.cos(pose.pitch);
    dist = clearDistance(cx, cy, cz, ex * D.SOLID, ey * D.SOLID, ez * D.SOLID, pose.tx, pose.ty, pose.tz,
      cp * Math.sin(pose.yaw), Math.sin(pose.pitch), cp * Math.cos(pose.yaw), dist, dMin);
    pose.dist = Math.max(dist, dMin);
  }
}
