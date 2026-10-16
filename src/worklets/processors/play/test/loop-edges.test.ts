import { describe, expect, it } from 'vite-plus/test';
import { reflectLoopPosition, wrapLoopPosition } from '../loop-edges.js';

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

describe('reflectLoopPosition', () => {
  it('is null inside [loopStart, loopEnd) and for the edge behind the playhead', () => {
    expect(reflectLoopPosition(150, 1, 100, 200)).toBeNull();
    expect(reflectLoopPosition(150, -1, 100, 200)).toBeNull();
    expect(reflectLoopPosition(250, -1, 100, 200)).toBeNull();
    expect(reflectLoopPosition(50, 1, 100, 200)).toBeNull();
  });

  it('mirrors the overshoot about the edge it reached', () => {
    expect(reflectLoopPosition(200.25, 1, 100, 200)).toBeCloseTo(199.75);
    expect(reflectLoopPosition(99.75, -1, 100, 200)).toBeCloseTo(100.25);
  });

  it('lands on the edge when the overshoot is a whole loop or more', () => {
    expect(reflectLoopPosition(350, 1, 100, 200)).toBe(200);
    expect(reflectLoopPosition(-50, -1, 100, 200)).toBe(100);
  });
});
