// SPDX-License-Identifier: AGPL-3.0-only
import type { Camera } from '../render/camera';
import { wobbleAt } from './select';
import type { LabelView } from './view';

/** z component of the shader's 3D wobble (render/shaders.ts WOBBLE); x, y come from wobbleAt(). */
export function wobbleZ(x: number, y: number, z: number, t: number, amp: number): number {
  return (
    amp *
    (Math.sin(z * 0.051 + t * 0.43 + 0.7) + Math.sin(x * 0.053 - t * 0.39 + 2.9) + 0.5 * Math.sin((y + z) * 0.11 + t * 0.7))
  );
}

/**
 * LabelView for the perspective orbit camera: world -> css px with depth.
 *
 * out[0], out[1] = css px (y down), out[2] = css px per world unit at the
 * point's depth (perspective: far labels get a smaller scale, so the layer's
 * zoom LOD curves fade them first). If `out` has a 4th slot it receives the
 * depth cue in [0.15, 1] (1 in front of the scene, low at its far side), the
 * same curve the renderer uses to fog distant veins, so labels can fade with
 * the veins they name. Points behind the near plane or far outside the view
 * return false.
 */
export class View3D implements LabelView {
  width = 1;
  height = 1;
  maxWobble = 0;
  private cam: Camera | null = null;
  private invDpr = 1;
  private amp = 0;
  private time = 0;
  private wob = new Float32Array(2);
  private tmp = new Float32Array(4);

  /** Call once per frame, after camera.update(). */
  begin(cam: Camera, devW: number, devH: number, dpr: number, wobbleAmp: number, time: number): void {
    this.cam = cam;
    this.invDpr = 1 / dpr;
    this.width = devW / dpr;
    this.height = devH / dpr;
    this.amp = wobbleAmp;
    this.time = time;
    this.maxWobble = 2.5 * wobbleAmp;
  }

  project(x: number, y: number, z: number, out: Float32Array, wobble: boolean): boolean {
    const cam = this.cam;
    if (!cam) return false;
    if (wobble) {
      wobbleAt(x, y, this.time, this.amp, this.wob);
      const wz = wobbleZ(x, y, z, this.time, this.amp);
      x += this.wob[0];
      y += this.wob[1];
      z += wz;
    }
    const t = this.tmp;
    if (!cam.project(x, y, z, t)) return false;
    out[0] = t[0] * this.invDpr;
    out[1] = t[1] * this.invDpr;
    out[2] = t[3] * this.invDpr;
    if (out.length > 3) {
      const f = smooth01((t[2] - cam.fogNear) / Math.max(1e-3, cam.fogFar - cam.fogNear));
      out[3] = 1 - 0.85 * f;
    }
    return true;
  }
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
