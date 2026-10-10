// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createFrameLimiter, parseMaxFps } from '../src/util/frameLimiter';

const count = (fps: number, hz: number, secs = 2) => {
  const l = createFrameLimiter(fps);
  let n = 0;
  for (let t = 0; t < secs * 1000; t += 1000 / hz) if (l.shouldRender(t)) n++;
  return n / secs;
};

describe('frameLimiter', () => {
  it('does not halve 60 or 100 Hz displays', () => {
    expect(count(100, 60)).toBeCloseTo(60, 0);
    expect(count(100, 100)).toBeGreaterThanOrEqual(99);
  });
  it('caps 144/240 Hz near 100', () => {
    expect(count(100, 240)).toBeLessThanOrEqual(121);
    expect(count(100, 240)).toBeGreaterThanOrEqual(80);
    expect(count(100, 144)).toBeLessThanOrEqual(105);
  });
  it('uncapped renders every frame', () => {
    expect(count(0, 240)).toBe(240);
  });
  it('resyncs after a stall', () => {
    const l = createFrameLimiter(100);
    l.shouldRender(0);
    expect(l.shouldRender(5000)).toBe(true);
    expect(l.shouldRender(5002)).toBe(false);
  });
  it('parses fps param', () => {
    expect(parseMaxFps(null)).toBe(100);
    expect(parseMaxFps('0')).toBe(0);
    expect(parseMaxFps('off')).toBe(0);
    expect(parseMaxFps('5')).toBe(10);
    expect(parseMaxFps('999')).toBe(240);
    expect(parseMaxFps('abc')).toBe(100);
    expect(parseMaxFps('60')).toBe(60);
  });
});
