// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Microscope / macro-lens look at the edges of the viewport. Pure logic (no DOM, no GL): unit-tested. The GLSL lives in
 * `shaders.ts` (`finalFs`), the uniforms in `renderer.ts`.
 *
 * The look is always on and has no user setting (no URL parameter, key or button): it is part of how Phloem looks. Only the
 * quality tier (quality.ts, including the automatic governor) and `prefers-reduced-motion` change what is drawn.
 *
 * Nothing here moves scene geometry (no barrel/pincushion distortion), so the label layer's projection (`labels/view3d.ts`)
 * and hover picking stay exactly aligned with the veins. The only displacement is the radial R/B chromatic offset (G, the
 * channel that carries the luminance, stays put; R and B move by at most ~2 px at the far corners).
 *
 * Tiers:
 *   high   : vignette + field stop, edge defocus (mip blur), chromatic aberration, lens dust, rim glare + ghost
 *   medium : vignette + field stop, chromatic aberration, rim glare + ghost (no blur, no dust)
 *   low    : vignette + field stop only (no extra texture reads)
 */
import type { QualityTier } from './quality';

/** Shader variant: 0 = plain final pass (identical to the pre-lens renderer), 1 vignette, 2 + CA + glare, 3 + blur + dust. */
export type LensLevel = 0 | 1 | 2 | 3;

/** What the final pass needs; every strength is 0 or 1 (a feature is drawn or it is not). */
export interface LensParams {
  level: LensLevel;
  /** Warm dark falloff toward the edges. */
  vignette: number;
  /** Rounded field-of-view edge that darkens the corners (an ellipse that follows the viewport on wide screens). */
  aperture: number;
  /** Radial R/B offset. */
  chroma: number;
  /** Edge defocus (mip level of the scene target sampled toward the edges). */
  blur: number;
  /** Faint static dust specks near the rim. */
  dust: number;
  /** Rim glare crescent and field-stop arc. */
  glare: number;
  /** The glare ghost follows the bloom (bright floods and bursts); 0 under prefers-reduced-motion, where the glare is static. */
  response: number;
}

/** Shader level a tier draws. */
export function lensLevel(tier: QualityTier): LensLevel {
  return tier === 'high' ? 3 : tier === 'medium' ? 2 : 1;
}

/** The "lens off" parameters (plain final pass): only for measurements and tests, there is no user-facing way to get here. */
export const LENS_OFF: Readonly<LensParams> = Object.freeze({
  level: 0,
  vignette: 0,
  aperture: 0,
  chroma: 0,
  blur: 0,
  dust: 0,
  glare: 0,
  response: 0,
});

/** What a tier draws, and with prefers-reduced-motion whether the glare may follow the bloom. */
export function lensParams(tier: QualityTier, reducedMotion = false): LensParams {
  const level = lensLevel(tier);
  return {
    level,
    vignette: 1,
    aperture: 1,
    chroma: level >= 2 ? 1 : 0,
    blur: level >= 3 ? 1 : 0,
    dust: level >= 3 ? 1 : 0,
    glare: level >= 2 ? 1 : 0,
    response: reducedMotion || level < 2 ? 0 : 1,
  };
}
