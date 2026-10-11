// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import { NodeKind } from '../model/tree';
import { A, ANCHOR_STRIDE, H, P, PULSE_STRIDE, anchorOffset, pulseOffset } from '../sim/frame';
import type { LabelModel } from './model';
import { ReachTracker, isReached } from './reach';
import {
  ACTIVE_FADE,
  ACTIVE_HOLD,
  FOLDER_LOD_MIN,
  LabelPlanner,
  PIN_SCORE,
  activity,
  ambientFileLod,
  flash,
  folderAlpha,
  folderLod,
  folderScore,
  labelBudget,
  smoothTo,
  stepAlpha,
} from './select';
import type { LabelView } from './view';

/**
 * Gource-style name labels drawn on a 2D canvas above the WebGL stage, plus a
 * hover tooltip. See docs/ARCHITECTURE.md ("Labels").
 *
 * Data: the sim frame's anchor section (id, x, y, z, reached per live file/folder)
 * and the pulse section (author comets). Names come from the LabelModel replica.
 * Per frame: build candidates (scored by recency / subtree size / zoom), place
 * them greedily without overlap, then fade and slide the persistent per-key
 * states. Labels are anchored in world space (projected by the LabelView with the
 * same camera and wobble as the shader) and only their slot offset is smoothed,
 * so orbiting, panning, zooming and wobbling never make text swim.
 */
export type LabelMode = 'all' | 'active' | 'off';
export const LABEL_MODES: LabelMode[] = ['all', 'active', 'off'];

const KEY_BASE = 32; // keys [0, 32) are author slots, node ids start here
const MAX_AUTHORS = 32;
const FONT_FACE = "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";
const FONTS = [
  `500 11.5px ${FONT_FACE}`, // 0 file
  `italic 500 12.5px ${FONT_FACE}`, // 1..4 folder by subtree size
  `italic 500 13.5px ${FONT_FACE}`,
  `italic 500 15px ${FONT_FACE}`,
  `italic 500 17px ${FONT_FACE}`,
  `600 12.5px ${FONT_FACE}`, // 5 author
];
const FONT_PX = [11.5, 12.5, 13.5, 15, 17, 12.5];
const KIND_FILE = 0;
const KIND_DIR = 1;
const KIND_AUTHOR = 2;
const FILE_RGB = '236,220,178';
const DIR_RGB = '255,231,163';
const FLASH_RGB = '255,247,214';
const HALO = 'rgba(14,9,3,0.78)';
/** Candidate caps (keep per-frame work bounded however busy the history is). */
const MAX_RECENT = 200;
const MAX_FILLERS = 400;

export interface LabelStats {
  /** Labels with non-zero alpha drawn last frame (including ones fading out). */
  drawn: number;
  /** Candidates offered to the planner last frame. */
  candidates: number;
  /** EMA of update + draw cost in ms (main thread). */
  ms: number;
  /** EMA of the per-sim-frame intake cost (replica sync + anchor/pulse copy) in ms. */
  intakeMs: number;
  /** Largest per-frame alpha change / slot-offset slide (css px) of any shown label last frame (popping/jitter probes). */
  maxAlphaStep: number;
  maxOffStep: number;
  /** EMA ms per phase: [candidates + hover, place, fade/slide, draw]. */
  phase: number[];
}

export class LabelLayer {
  mode: LabelMode = 'active';
  readonly stats: LabelStats = { drawn: 0, candidates: 0, ms: 0, intakeMs: 0, maxAlphaStep: 0, maxOffStep: 0, phase: [0, 0, 0, 0] };
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLElement;
  private tipPath: HTMLElement;
  private tipMsg: HTMLElement;
  private tipMeta: HTMLElement;
  private tipW = 0;
  private tipH = 0;
  private planner = new LabelPlanner(2048, 192);

  // latest frame copies (the sim buffer is handed back to the worker before we draw)
  private anc = new Float32Array(4096);
  private ancN = 0;
  private pls = new Float32Array(1024);
  private plsN = 0;
  private anchorOf = new Int32Array(1024);
  private anchorStamp = new Int32Array(1024);
  private frameNo = 0;
  private reach = new ReachTracker();

  // persistent per-key state (struct of arrays; key = KEY_BASE + node id, or an author slot)
  private cap = 0;
  private alpha = new Float32Array(0);
  private tgt = new Float32Array(0); // target alpha chosen this frame
  private candTgt = new Float32Array(0);
  private offX = new Float32Array(0);
  private offY = new Float32Array(0);
  private slot = new Int8Array(0);
  private wx = new Float32Array(0);
  private wy = new Float32Array(0);
  private wz = new Float32Array(0);
  private tw = new Float32Array(0); // measured text width
  private th = new Float32Array(0);
  private font = new Uint8Array(0);
  private kind = new Uint8Array(0);
  private flashAmt = new Float32Array(0);
  private inLive = new Uint8Array(0);
  private measuredFont = new Uint8Array(0);
  private str: string[] = [];
  private color: string[] = [];
  private live = new Int32Array(256);
  private liveN = 0;

  // authors
  private authorOf = new Int32Array(MAX_AUTHORS).fill(-1);
  private authorX = new Float32Array(MAX_AUTHORS);
  private authorY = new Float32Array(MAX_AUTHORS);
  private authorZ = new Float32Array(MAX_AUTHORS);
  private authorSeen = new Float64Array(MAX_AUTHORS).fill(-Infinity);
  private authorPickX = new Float32Array(MAX_AUTHORS);
  private authorPickY = new Float32Array(MAX_AUTHORS);
  private authorPickZ = new Float32Array(MAX_AUTHORS);
  private authorPickI = new Float32Array(MAX_AUTHORS);
  private authorPicked = new Uint8Array(MAX_AUTHORS);
  private authorSlotOf = new Int32Array(0);

  // hover
  private px = -1;
  private py = -1;
  private pointerOn = false;
  private suppressHover = false;
  hoverId = -1;
  private tipId = -2;
  private tipCommit = -2;

  // per-frame scratch
  private p3 = new Float32Array(4);
  private budget = 0;
  private scaleEma = 1;
  private scaleSum = 0;
  private scaleN = 0;
  private fillers = 0;
  private hoverSeen = false;
  private cssW = 0;
  private cssH = 0;
  private hadContent = false;

  constructor(stage: HTMLCanvasElement, readonly model: LabelModel) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'labels';
    this.canvas.setAttribute('aria-hidden', 'true');
    stage.after(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.tip.innerHTML = '<div class="tip-path"></div><div class="tip-msg"></div><div class="tip-meta"></div>';
    this.tipPath = this.tip.children[0] as HTMLElement;
    this.tipMsg = this.tip.children[1] as HTMLElement;
    this.tipMeta = this.tip.children[2] as HTMLElement;
    this.canvas.after(this.tip);
    this.grow(1024);
  }

  /** (Re)load the history the replica reads. Call again if the commit list is replaced. */
  /** Ingestion: more commits (oldest first) after `setCommits`; keeps the replica and author slots in sync without a reset. */
  appendCommits(more: CommitEvent[]): void {
    this.model.appendCommits(more);
    if (this.authorSlotOf.length < this.model.authors.length) {
      const grown = new Int32Array(Math.max(this.model.authors.length, this.authorSlotOf.length * 2)).fill(-1);
      grown.set(this.authorSlotOf);
      this.authorSlotOf = grown;
    }
  }

  setCommits(commits: CommitEvent[]): void {
    this.model.setCommits(commits);
    this.authorSlotOf = new Int32Array(this.model.authors.length).fill(-1);
    this.authorOf.fill(-1);
    this.authorSeen.fill(-Infinity);
    this.alpha.fill(0);
    this.inLive.fill(0);
    this.liveN = 0;
    this.reach.reset();
    this.hoverId = -1;
  }

  setMode(m: LabelMode): void {
    this.mode = m;
  }

  /** Pointer position in css px relative to the viewport; call with on=false when it leaves. */
  setPointer(x: number, y: number, on: boolean): void {
    this.px = x;
    this.py = y;
    this.pointerOn = on;
    if (on && !this.tip.hidden) this.placeTip();
  }

  /** Screen rectangles (css px) labels must stay clear of, e.g. the commit caption. Pass x, y, w, h per rect. */
  setObstacles(rects: number[]): void {
    this.planner.obstacles.length = 0;
    for (const v of rects) this.planner.obstacles.push(v);
  }

  /** Suppress hover (e.g. while dragging). */
  setDragging(d: boolean): void {
    this.suppressHover = d;
  }

  private grow(n: number): void {
    if (n <= this.cap) return;
    let c = Math.max(this.cap, 1024);
    while (c < n) c *= 2;
    const g32 = (a: Float32Array) => {
      const r = new Float32Array(c);
      r.set(a);
      return r;
    };
    const g8 = (a: Uint8Array) => {
      const r = new Uint8Array(c);
      r.set(a);
      return r;
    };
    this.alpha = g32(this.alpha);
    this.tgt = g32(this.tgt);
    this.candTgt = g32(this.candTgt);
    this.offX = g32(this.offX);
    this.offY = g32(this.offY);
    this.wx = g32(this.wx);
    this.wy = g32(this.wy);
    this.wz = g32(this.wz);
    this.tw = g32(this.tw);
    this.th = g32(this.th);
    this.flashAmt = g32(this.flashAmt);
    this.font = g8(this.font);
    this.kind = g8(this.kind);
    this.inLive = g8(this.inLive);
    this.measuredFont = g8(this.measuredFont);
    const s = new Int8Array(c);
    s.set(this.slot);
    this.slot = s;
    this.cap = c;
  }

  // ------------------------------------------------------------ frame intake
  /** Copy what we need from a freshly received sim frame (call before the buffer is handed back). */
  onFrame(f: Float32Array, nowSec: number): void {
    const t0 = performance.now();
    this.model.sync(f[H.commit], nowSec);
    const n = f[H.anchors] | 0;
    const ao = anchorOffset(f);
    if (this.anc.length < n * ANCHOR_STRIDE) this.anc = new Float32Array(Math.ceil(n * ANCHOR_STRIDE * 1.5));
    this.anc.set(f.subarray(ao, ao + n * ANCHOR_STRIDE));
    this.ancN = n;
    const pn = f[H.pulses] | 0;
    const po = pulseOffset(f);
    if (this.pls.length < pn * PULSE_STRIDE) this.pls = new Float32Array(Math.ceil(pn * PULSE_STRIDE * 1.5));
    this.pls.set(f.subarray(po, po + pn * PULSE_STRIDE));
    this.plsN = pn;
    // id -> anchor index
    const nodes = this.model.tree.nodes.length;
    if (this.anchorOf.length < nodes + 1) {
      const len = Math.max(nodes + 1, this.anchorOf.length * 2);
      const a = new Int32Array(len);
      const b = new Int32Array(len);
      a.set(this.anchorOf);
      b.set(this.anchorStamp);
      this.anchorOf = a;
      this.anchorStamp = b;
    }
    const stamp = ++this.frameNo;
    const anc = this.anc;
    for (let i = 0; i < n; i++) {
      const id = anc[i * ANCHOR_STRIDE + A.id] | 0;
      if (id < this.anchorOf.length) {
        this.anchorOf[id] = i;
        this.anchorStamp[id] = stamp;
      }
    }
    // A file touched by a commit is highlighted when the mold gets to it, not when the commit lands.
    this.reach.begin(f[H.commit]);
    const model = this.model;
    for (let i = 0; i < n; i++) {
      const o = i * ANCHOR_STRIDE;
      const id = anc[o + A.id] | 0;
      if (!this.reach.step(id, isReached(anc[o + A.reached]))) continue;
      if (model.tree.nodes[id]?.kind === NodeKind.File && model.touchedAt[id] > -Infinity) {
        model.touchedAt[id] = nowSec;
        model.recentIds.push(id);
        model.recentAt.push(nowSec);
      }
    }
    this.grow(KEY_BASE + nodes + 1);
    this.stats.intakeMs = this.stats.intakeMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  private anchorIndex(id: number): number {
    return id < this.anchorStamp.length && this.anchorStamp[id] === this.frameNo ? this.anchorOf[id] : -1;
  }

  // ------------------------------------------------------------ per frame
  /**
   * Plan, fade and draw one frame. `view` projects world -> css px; `dpr` is
   * device px per css px (canvas backing store scale); `bottomReserve` is the
   * css height of bottom UI chrome labels must stay out of.
   */
  update(nowSec: number, dt: number, view: LabelView, dpr: number, bottomReserve: number): void {
    const t0 = performance.now();
    const cssW = view.width;
    const cssH = view.height;
    const devW = Math.round(cssW * dpr);
    const devH = Math.round(cssH * dpr);
    if (this.canvas.width !== devW || this.canvas.height !== devH) {
      this.canvas.width = devW;
      this.canvas.height = devH;
    }
    this.cssW = cssW;
    this.cssH = cssH;
    const ctx = this.ctx;
    const mode = this.mode;
    const model = this.model;
    const planner = this.planner;
    planner.reset();
    this.budget = 48;
    this.scaleSum = 0;
    this.scaleN = 0;
    this.fillers = 0;
    this.hoverSeen = false;

    const hover = this.pickHover(view);
    this.hoverId = hover;
    this.updateTip(hover);

    if (mode !== 'off') {
      // ---- candidates: recently touched files (newest first), folders, ambient files when zoomed in, authors
      model.pruneRecent(nowSec, ACTIVE_HOLD + ACTIVE_FADE);
      const ids = model.recentIds;
      const at = model.recentAt;
      let seen = 0;
      for (let k = ids.length - 1; k >= model.recentHead && seen < MAX_RECENT; k--) {
        const id = ids[k];
        if (model.touchedAt[id] !== at[k]) continue; // superseded by a later touch
        seen++;
        this.consider(id, this.anchorIndex(id), nowSec, view, hover, false);
      }
      if (mode === 'all') {
        const dirs = model.dirIds;
        for (let k = 0; k < dirs.length; k++) this.consider(dirs[k], this.anchorIndex(dirs[k]), nowSec, view, hover, false);
        // ambient file names, only when zoomed in enough that they fit
        if (this.scaleEma > 2) {
          const anc = this.anc;
          for (let i = 0; i < this.ancN && this.fillers < MAX_FILLERS; i++) {
            const id = anc[i * ANCHOR_STRIDE + A.id] | 0;
            if (model.tree.nodes[id]?.kind !== NodeKind.File) continue;
            this.consider(id, i, nowSec, view, hover, true);
          }
        }
      }
      this.addAuthors(nowSec, dt, view);
    }
    if (hover >= 0 && !this.hoverSeen) this.consider(hover, this.anchorIndex(hover), nowSec, view, hover, false);
    if (this.scaleN > 0) this.scaleEma = smoothTo(this.scaleEma, this.scaleSum / this.scaleN, dt, 0.4);
    const t1 = performance.now();

    // ---- place
    const limit = mode === 'off' ? 0 : labelBudget(mode, this.scaleEma);
    planner.plan(limit, 6, 6, cssW - 6, cssH - bottomReserve, 2);
    this.stats.candidates = planner.n;
    const t2 = performance.now();

    // ---- states: targets, slide, fade
    for (let k = 0; k < this.liveN; k++) this.tgt[this.live[k]] = 0;
    let maxOff = 0;
    for (let p = 0; p < planner.placed; p++) {
      const c = planner.outCand[p];
      const key = planner.key[c];
      const dx = planner.outX[p] - planner.ax[c];
      const dy = planner.outY[p] - planner.ay[c];
      if (this.alpha[key] <= 0.001 || !this.inLive[key]) {
        this.offX[key] = dx;
        this.offY[key] = dy;
      } else {
        const ox = this.offX[key];
        const oy = this.offY[key];
        this.offX[key] = smoothTo(ox, dx, dt, 0.09);
        this.offY[key] = smoothTo(oy, dy, dt, 0.09);
        const step = Math.abs(this.offX[key] - ox) + Math.abs(this.offY[key] - oy);
        if (step > maxOff) maxOff = step;
      }
      this.slot[key] = planner.outSlot[p];
      this.tgt[key] = this.candTgt[key];
      if (!this.inLive[key]) {
        if (this.liveN >= this.live.length) {
          const l = new Int32Array(this.live.length * 2);
          l.set(this.live);
          this.live = l;
        }
        this.live[this.liveN++] = key;
        this.inLive[key] = 1;
      }
    }
    let w = 0;
    let maxAlpha = 0;
    for (let k = 0; k < this.liveN; k++) {
      const key = this.live[k];
      const prev = this.alpha[key];
      const a = stepAlpha(prev, this.tgt[key], dt, 0.4, 0.3);
      if (Math.abs(a - prev) > maxAlpha) maxAlpha = Math.abs(a - prev);
      this.alpha[key] = a;
      if (a <= 0.003 && this.tgt[key] === 0) {
        this.alpha[key] = 0;
        this.inLive[key] = 0;
        continue;
      }
      this.live[w++] = key;
    }
    this.liveN = w;
    this.stats.maxAlphaStep = maxAlpha;
    this.stats.maxOffStep = maxOff;
    const t3 = performance.now();

    // ---- draw
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.hadContent || this.liveN > 0 || hover >= 0) ctx.clearRect(0, 0, cssW, cssH);
    this.hadContent = false;
    let drawn = 0;
    if (this.liveN > 0) {
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      // one pass per font so the context font changes at most a handful of times
      for (let fid = 0; fid < FONTS.length; fid++) {
        let fontSet = false;
        for (let k = 0; k < this.liveN; k++) {
          const key = this.live[k];
          if (this.font[key] !== fid || this.alpha[key] <= 0.01) continue;
          if (!fontSet) {
            ctx.font = FONTS[fid];
            fontSet = true;
          }
          if (this.drawLabel(ctx, key, view, dpr)) drawn++;
        }
      }
      this.hadContent = drawn > 0;
    }
    if (hover >= 0 && this.drawHoverRing(ctx, hover, view)) this.hadContent = true;
    this.stats.drawn = drawn;
    const t4 = performance.now();
    this.stats.ms = this.stats.ms * 0.9 + (t4 - t0) * 0.1;
    const ph = this.stats.phase;
    ph[0] = ph[0] * 0.9 + (t1 - t0) * 0.1;
    ph[1] = ph[1] * 0.9 + (t2 - t1) * 0.1;
    ph[2] = ph[2] * 0.9 + (t3 - t2) * 0.1;
    ph[3] = ph[3] * 0.9 + (t4 - t3) * 0.1;
  }

  /** Nearest anchor within reach of the pointer (files win ties against folders), or -1. */
  private pickHover(view: LabelView): number {
    if (!this.pointerOn || this.suppressHover) return -1;
    const P3 = this.p3;
    const anc = this.anc;
    const nodes = this.model.tree.nodes;
    let hover = -1;
    let best = Infinity;
    for (let i = 0; i < this.ancN; i++) {
      const o = i * ANCHOR_STRIDE;
      if (!view.project(anc[o + A.x], anc[o + A.y], anc[o + A.z], P3, false)) continue;
      const scale = P3[2];
      const reach = Math.max(11, 2.2 * scale + 5);
      const coarse = reach + view.maxWobble * scale + 2;
      const dx0 = P3[0] - this.px;
      const dy0 = P3[1] - this.py;
      if (dx0 > coarse || dx0 < -coarse || dy0 > coarse || dy0 < -coarse) continue;
      if (!isReached(anc[o + A.reached])) continue; // only nodes the mold has grown to can be hovered
      const id = anc[o + A.id] | 0;
      const node = nodes[id];
      if (!node) continue;
      view.project(anc[o + A.x], anc[o + A.y], anc[o + A.z], P3, true);
      const dx = P3[0] - this.px;
      const dy = P3[1] - this.py;
      const d2 = (dx * dx + dy * dy) * (node.kind === NodeKind.Folder ? 1.5 : 1);
      if (d2 < reach * reach && d2 < best) {
        best = d2;
        hover = id;
      }
    }
    return hover;
  }

  /**
   * Score one node and offer it to the planner. `ai` is its anchor index (-1: not in this frame).
   * `fillerPass`: called from the ambient scan, so active files (handled by the recent list) are skipped.
   */
  private consider(id: number, ai: number, nowSec: number, view: LabelView, hover: number, fillerPass: boolean): void {
    const isHover = id === hover;
    if (isHover) this.hoverSeen = true;
    if (ai < 0) return;
    const model = this.model;
    const node = model.tree.nodes[id];
    if (!node) return;
    const anc = this.anc;
    const o = ai * ANCHOR_STRIDE;
    const P3 = this.p3;
    const isDir = node.kind === NodeKind.Folder;
    if (!isReached(anc[o + A.reached])) return; // no name before the vein tip got there
    let age = Infinity;
    let act = 0;
    if (!isDir) {
      age = nowSec - model.touchedAt[id];
      act = activity(age);
      if (fillerPass && act > 0 && !isHover) return;
    }
    if (!view.project(anc[o + A.x], anc[o + A.y], anc[o + A.z], P3, false)) return;
    const cssW = this.cssW;
    const cssH = this.cssH;
    const margin = 24;
    if (P3[0] < -margin || P3[0] > cssW + margin || P3[1] < -margin || P3[1] > cssH + margin) return;
    const scale = P3[2];
    let score: number;
    let target: number;
    let fl = 0;
    if (isDir) {
      const lod = folderLod(node.liveFiles, scale);
      if (lod < FOLDER_LOD_MIN && !isHover) return;
      score = folderScore(node.liveFiles, node.depth);
      target = folderAlpha(lod);
    } else if (act > 0) {
      fl = flash(age);
      score = 70 + 30 * act + 25 * fl;
      target = act;
    } else {
      const lod = ambientFileLod(scale);
      if (lod <= 0 && !isHover) return;
      if (!isHover && this.fillers++ >= MAX_FILLERS) return;
      const cx = cssW * 0.5;
      const cy = cssH * 0.5;
      score = 10 - 5 * (Math.hypot(P3[0] - cx, P3[1] - cy) / Math.hypot(cx, cy));
      target = 0.62 * lod;
    }
    P3[3] = 1;
    view.project(anc[o + A.x], anc[o + A.y], anc[o + A.z], P3, true);
    const sx = P3[0];
    const sy = P3[1];
    const cue = (isDir ? 0.75 : 0.5) + (isDir ? 0.25 : 0.5) * P3[3]; // depth cue: far-side labels are dimmer and lose collisions
    score *= 0.6 + 0.4 * cue;
    target *= cue;
    this.scaleSum += scale;
    this.scaleN++;
    const key = KEY_BASE + id;
    if (key >= this.cap) this.grow(key + 1);
    const fid = isDir ? 1 + Math.min(3, Math.floor(Math.log2(1 + node.liveFiles) / 2.6)) : 0;
    if (!this.prepare(key, node.name, fid, isDir ? KIND_DIR : KIND_FILE)) return;
    if (this.alpha[key] > 0.05) score += 10; // hysteresis: keep what is already shown
    if (isHover) {
      score = PIN_SCORE;
      target = 1;
    }
    this.candTgt[key] = target;
    this.flashAmt[key] = fl;
    const gap = Math.min(20, 4 + 1.2 * scale) + (isDir ? 3 : 0);
    this.planner.add(key, score, sx, sy, this.tw[key], this.th[key], gap, this.slot[key]);
  }

  /** Make sure the key's text is set and measured. Returns false if the per-frame measuring budget ran out. */
  private prepare(key: number, text: string, fid: number, kind: number): boolean {
    if (this.str[key] !== text || this.measuredFont[key] !== fid + 1) {
      if (this.budget <= 0) return false;
      this.budget--;
      this.str[key] = text;
      this.ctx.font = FONTS[fid];
      this.tw[key] = this.ctx.measureText(text).width;
      this.th[key] = Math.round(FONT_PX[fid] * 1.3);
      this.measuredFont[key] = fid + 1;
    }
    this.font[key] = fid;
    this.kind[key] = kind;
    return true;
  }

  private addAuthors(nowSec: number, dt: number, view: LabelView): void {
    const model = this.model;
    const pls = this.pls;
    const P3 = this.p3;
    this.authorPicked.fill(0);
    for (let i = 0; i < this.plsN; i++) {
      const o = i * PULSE_STRIDE;
      const inten = pls[o + P.intensity];
      if (inten < 0.3) continue;
      const ai = model.hueIndex.get(pls[o + P.hue]);
      if (ai === undefined) continue;
      const s = this.authorSlot(ai, nowSec);
      const x = pls[o + P.x];
      const y = pls[o + P.y];
      const z = pls[o + P.z];
      // follow the pulse nearest to where the label already is; a new author takes the brightest
      let better: boolean;
      if (!this.authorPicked[s]) better = true;
      else if (nowSec - this.authorSeen[s] < 0.8) {
        const dNew = (x - this.authorX[s]) ** 2 + (y - this.authorY[s]) ** 2 + (z - this.authorZ[s]) ** 2;
        const dOld = (this.authorPickX[s] - this.authorX[s]) ** 2 + (this.authorPickY[s] - this.authorY[s]) ** 2 + (this.authorPickZ[s] - this.authorZ[s]) ** 2;
        better = dNew < dOld;
      } else better = inten > this.authorPickI[s];
      if (better) {
        this.authorPicked[s] = 1;
        this.authorPickX[s] = x;
        this.authorPickY[s] = y;
        this.authorPickZ[s] = z;
        this.authorPickI[s] = inten;
      }
    }
    for (let s = 0; s < MAX_AUTHORS; s++) {
      const ai = this.authorOf[s];
      if (ai < 0) continue;
      if (this.authorPicked[s]) {
        if (nowSec - this.authorSeen[s] > 0.8) {
          this.authorX[s] = this.authorPickX[s];
          this.authorY[s] = this.authorPickY[s];
          this.authorZ[s] = this.authorPickZ[s];
        } else {
          const k = 1 - Math.exp(-dt * 12);
          this.authorX[s] += (this.authorPickX[s] - this.authorX[s]) * k;
          this.authorY[s] += (this.authorPickY[s] - this.authorY[s]) * k;
          this.authorZ[s] += (this.authorPickZ[s] - this.authorZ[s]) * k;
        }
        this.authorSeen[s] = nowSec;
      }
      if (nowSec - this.authorSeen[s] > 0.9) continue;
      P3[3] = 1;
      if (!view.project(this.authorX[s], this.authorY[s], this.authorZ[s], P3, true)) continue;
      if (!this.prepare(s, model.authors[ai], 5, KIND_AUTHOR)) continue;
      if (!this.color[s]) this.color[s] = `hsl(${Math.round(model.authorHues[ai] * 360)},62%,76%)`;
      this.candTgt[s] = 1;
      this.flashAmt[s] = 0;
      this.planner.add(s, 200, P3[0], P3[1], this.tw[s], this.th[s], 7, this.slot[s] === 0 ? 4 : this.slot[s]);
    }
  }

  private authorSlot(ai: number, nowSec: number): number {
    let s = this.authorSlotOf[ai];
    if (s >= 0 && this.authorOf[s] === ai) return s;
    let stalest = 0;
    let stale = Infinity;
    s = -1;
    for (let i = 0; i < MAX_AUTHORS; i++) {
      if (this.authorOf[i] < 0) {
        s = i;
        break;
      }
      if (this.authorSeen[i] < stale) {
        stale = this.authorSeen[i];
        stalest = i;
      }
    }
    if (s < 0) {
      s = stalest;
      const old = this.authorOf[s];
      if (old >= 0) this.authorSlotOf[old] = -1;
    }
    this.authorOf[s] = ai;
    this.authorSlotOf[ai] = s;
    this.authorSeen[s] = nowSec - 10;
    this.color[s] = '';
    this.alpha[s] = 0;
    return s;
  }

  private drawLabel(ctx: CanvasRenderingContext2D, key: number, view: LabelView, dpr: number): boolean {
    const P3 = this.p3;
    let wx: number;
    let wy: number;
    let wz: number;
    if (key >= KEY_BASE) {
      // follow the anchor while it exists; fading labels of removed files keep their last place
      const ai = this.anchorIndex(key - KEY_BASE);
      if (ai >= 0) {
        const o = ai * ANCHOR_STRIDE;
        this.wx[key] = this.anc[o + A.x];
        this.wy[key] = this.anc[o + A.y];
        this.wz[key] = this.anc[o + A.z];
      }
      wx = this.wx[key];
      wy = this.wy[key];
      wz = this.wz[key];
    } else {
      wx = this.authorX[key];
      wy = this.authorY[key];
      wz = this.authorZ[key];
    }
    P3[3] = 1;
    if (!view.project(wx, wy, wz, P3, true)) return false;
    const dirKind = this.kind[key] === KIND_DIR;
    const a = this.alpha[key] * ((dirKind ? 0.75 : 0.5) + (dirKind ? 0.25 : 0.5) * P3[3]);
    // snap to device pixels so static labels stay crisp (anchors still move sub-pixel)
    const x = Math.round((P3[0] + this.offX[key]) * dpr) / dpr;
    const yMid = Math.round((P3[1] + this.offY[key] + this.th[key] / 2) * dpr) / dpr;
    const text = this.str[key];
    const kind = this.kind[key];
    const fl = this.flashAmt[key];
    ctx.globalAlpha = a;
    if (fl > 0.02) {
      ctx.lineWidth = 5;
      ctx.strokeStyle = `rgba(255,190,70,${(0.3 * fl).toFixed(3)})`;
      ctx.strokeText(text, x, yMid);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = HALO;
    ctx.strokeText(text, x, yMid);
    ctx.fillStyle = kind === KIND_AUTHOR ? this.color[key] : fl > 0.35 ? `rgb(${FLASH_RGB})` : `rgb(${kind === KIND_DIR ? DIR_RGB : FILE_RGB})`;
    ctx.fillText(text, x, yMid);
    ctx.globalAlpha = 1;
    return true;
  }

  private drawHoverRing(ctx: CanvasRenderingContext2D, id: number, view: LabelView): boolean {
    const ai = this.anchorIndex(id);
    if (ai < 0) return false;
    const o = ai * ANCHOR_STRIDE;
    const P3 = this.p3;
    if (!view.project(this.anc[o + A.x], this.anc[o + A.y], this.anc[o + A.z], P3, true)) return false;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = `rgba(${FLASH_RGB},0.85)`;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(P3[0], P3[1], Math.min(18, 5 + 1.3 * P3[2]), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return true;
  }

  // ------------------------------------------------------------ tooltip
  private updateTip(id: number): void {
    if (id < 0) {
      if (!this.tip.hidden) this.tip.hidden = true;
      this.tipId = -2;
      return;
    }
    const node = this.model.tree.nodes[id];
    if (!node) return;
    const lc = this.model.lastCommit[id] ?? -1;
    if (id !== this.tipId || lc !== this.tipCommit) {
      this.tipId = id;
      this.tipCommit = lc;
      const isDir = node.kind === NodeKind.Folder;
      this.tipPath.textContent = isDir ? `${node.path}/` : node.path;
      if (isDir) {
        this.tipMsg.textContent = `${node.liveFiles} file${node.liveFiles === 1 ? '' : 's'}`;
        this.tipMeta.textContent = '';
      } else {
        const c = lc >= 0 ? this.model.commits[lc] : undefined;
        if (c) {
          this.tipMsg.textContent = c.message;
          const d = new Date(c.date);
          const date = Number.isNaN(d.getTime()) ? c.date : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
          this.tipMeta.textContent = `${c.author}, ${c.hash.slice(0, 7)}, ${date}`;
        } else {
          this.tipMsg.textContent = '';
          this.tipMeta.textContent = '';
        }
      }
      this.tip.hidden = false;
      this.tipW = this.tip.offsetWidth;
      this.tipH = this.tip.offsetHeight;
    }
    this.tip.hidden = false;
    this.placeTip();
  }

  private placeTip(): void {
    let x = this.px + 16;
    let y = this.py + 18;
    if (x + this.tipW > this.cssW - 8) x = this.px - 16 - this.tipW;
    if (y + this.tipH > this.cssH - 8) y = this.py - 18 - this.tipH;
    this.tip.style.transform = `translate(${Math.max(8, x).toFixed(0)}px,${Math.max(8, y).toFixed(0)}px)`;
  }
}
