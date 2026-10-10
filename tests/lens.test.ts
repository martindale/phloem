// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { LENS_OFF, lensLevel, lensParams } from '../src/render/lens';
import { QUALITY_TIERS } from '../src/render/quality';
import { finalFs } from '../src/render/shaders';
import { parseViewerParams, patchSearch, stateToPatch } from '../src/web/urlstate';

describe('lens tier mapping', () => {
  it('maps tiers to shader levels: high full, medium cheaper, low vignette only', () => {
    expect(lensLevel('high')).toBe(3);
    expect(lensLevel('medium')).toBe(2);
    expect(lensLevel('low')).toBe(1);
  });
  it('is always on: every tier draws at least the vignette and the field stop at full strength', () => {
    for (const t of QUALITY_TIERS) {
      const p = lensParams(t);
      expect(p.level).toBeGreaterThan(0);
      expect(p.vignette).toBe(1);
      expect(p.aperture).toBe(1);
    }
  });
  it('drops blur and dust on medium, and everything but vignette and field stop on low', () => {
    expect(lensParams('high')).toMatchObject({ level: 3, chroma: 1, blur: 1, dust: 1, glare: 1, response: 1 });
    const med = lensParams('medium');
    expect(med).toMatchObject({ level: 2, chroma: 1, glare: 1, blur: 0, dust: 0 });
    expect(lensParams('low')).toMatchObject({ level: 1, chroma: 0, blur: 0, dust: 0, glare: 0, response: 0 });
  });
  it('reduced motion keeps the look but stops the glare ghost following the bloom', () => {
    const p = lensParams('high', true);
    expect(p.glare).toBe(1);
    expect(p.response).toBe(0);
    expect(lensParams('medium', true).response).toBe(0);
  });
  it('the plain pass (measurement reference) is level 0 with nothing drawn', () => {
    expect(LENS_OFF.level).toBe(0);
    expect(Object.values(LENS_OFF).every((v) => v === 0)).toBe(true);
  });
});

describe('the lens has no user-facing setting', () => {
  it('is not part of the URL contract: ?lens= is ignored and never written', () => {
    expect(parseViewerParams('?lens=off')).not.toHaveProperty('lens');
    expect(stateToPatch({ labels: 'all', speed: 1 })).not.toHaveProperty('lens');
    expect(patchSearch('?repo=a/b&lens=off', {})).toBe('?repo=a/b&lens=off'); // unknown params are preserved as ever
  });
});

describe('final pass shader', () => {
  it('compiles one source per level from the same template', () => {
    for (const l of [0, 1, 2, 3] as const) expect(finalFs(l)).toContain(`#define LENS ${l}`);
  });
});
