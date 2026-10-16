import { describe, expect, it } from 'vite-plus/test';
import { wrapLoopPosition } from '../wrap-loop-position.js';

describe('wrapLoopPosition', () => {
  it('is null inside [loopStart, loopEnd) in both directions', () => {
    expect(wrapLoopPosition(100, 1, 100, 200)).toBeNull();
    expect(wrapLoopPosition(199.9, 1, 100, 200)).toBeNull();
    expect(wrapLoopPosition(100, -1, 100, 200)).toBeNull();
    expect(wrapLoopPosition(199.9, -1, 100, 200)).toBeNull();
  });

  it('ignores the edge behind the playhead', () => {
    expect(wrapLoopPosition(250, -1, 100, 200)).toBeNull();
    expect(wrapLoopPosition(50, 1, 100, 200)).toBeNull();
  });

  it('carries the overshoot across the edge', () => {
    expect(wrapLoopPosition(200.25, 1, 100, 200)).toBeCloseTo(100.25);
    expect(wrapLoopPosition(99.75, -1, 100, 200)).toBeCloseTo(199.75);
  });

  it('lands on the far edge when the overshoot is a whole loop or more', () => {
    expect(wrapLoopPosition(350, 1, 100, 200)).toBe(100);
    expect(wrapLoopPosition(-50, -1, 100, 200)).toBe(200);
  });
});
