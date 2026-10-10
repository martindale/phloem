// SPDX-License-Identifier: AGPL-3.0-only
import { wobbleAt } from './select';

/**
 * How the label layer sees the camera. The layer never touches camera maths
 * itself, so the projection (and the CPU copy of the shader wobble) can change
 * (e.g. 2D -> 3D orbit camera) without touching the planner/state code.
 */
export interface LabelView {
  /** Viewport size in css px. */
  width: number;
  height: number;
  /** Upper bound of the wobble displacement in world units (margin for coarse hover culling). */
  maxWobble: number;
  /**
   * Project a world point to css px, with the renderer's wobble applied when `wobble` is true.
   * out[0], out[1] = screen x, y (y down); out[2] = css px per world unit at that depth;
   * out[3] (if present) = depth cue in (0, 1], 1 = nearest (labels on the far side fade).
   * Returns false when the point cannot be shown (e.g. behind the camera).
   */
  project(x: number, y: number, z: number, out: Float32Array, wobble: boolean): boolean;
}

/** View for the current top-down 2D camera (z is ignored). */
export class View2D implements LabelView {
  width = 1;
  height = 1;
  maxWobble = 0;
  private cx = 0;
  private cy = 0;
  private zoom = 1; // device px per world unit
  private halfW = 0;
  private halfH = 0;
  private invDpr = 1;
  private amp = 0;
  private time = 0;
  private wob = new Float32Array(2);

  /** Call once per frame before projecting. */
  begin(cam: { cx: number; cy: number; zoom: number }, devW: number, devH: number, dpr: number, wobbleAmp: number, time: number): void {
    this.cx = cam.cx;
    this.cy = cam.cy;
    this.zoom = cam.zoom;
    this.halfW = devW / 2;
    this.halfH = devH / 2;
    this.invDpr = 1 / dpr;
    this.width = devW / dpr;
    this.height = devH / dpr;
    this.amp = wobbleAmp;
    this.time = time;
    this.maxWobble = 2.5 * wobbleAmp;
  }

  project(x: number, y: number, _z: number, out: Float32Array, wobble: boolean): boolean {
    if (wobble) {
      wobbleAt(x, y, this.time, this.amp, this.wob);
      x += this.wob[0];
      y += this.wob[1];
    }
    out[0] = ((x - this.cx) * this.zoom + this.halfW) * this.invDpr;
    out[1] = (this.halfH - (y - this.cy) * this.zoom) * this.invDpr;
    out[2] = this.zoom * this.invDpr;
    if (out.length > 3) out[3] = 1;
    return true;
  }
}
