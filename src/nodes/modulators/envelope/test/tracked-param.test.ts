import { expect, test } from 'vite-plus/test';
import { TrackedParam } from '../tracked-param';
import { createFakeParam } from './fakeParam';

function tracked() {
  const param = createFakeParam();
  return { param, tracked: new TrackedParam(param, { currentTime: 0 }) };
}

test('reads linear and exponential ramps with the Web Audio formulas', () => {
  const { tracked: p } = tracked();
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(1, 1);
  p.exponentialRampToValueAtTime(0.01, 2);

  expect(p.valueAt(0.5)).toBeCloseTo(0.5);
  expect(p.valueAt(1.5)).toBeCloseTo(0.1); // sqrt(1 * 0.01)
  expect(p.valueAt(3)).toBeCloseTo(0.01);
});

test('an exponential ramp from zero holds at zero, as the spec says', () => {
  const { tracked: p } = tracked();
  p.setValueAtTime(0, 0);
  p.exponentialRampToValueAtTime(1, 1);

  expect(p.valueAt(0.5)).toBe(0);
});

test('a future hold shortens the ramp in flight instead of freezing the param now', () => {
  const { param, tracked: p } = tracked();
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(1, 1);

  expect(p.holdAt(0.25)).toBeCloseTo(0.25);
  // Still ramping up to the hold, then pinned there.
  expect(param.ramps().slice(-2)).toEqual([
    { type: 'linear', value: 0.25, time: 0.25 },
    { type: 'set', value: 0.25, time: 0.25 },
  ]);
  expect(p.valueAt(0.1)).toBeCloseTo(0.1);
});

test('a hold exactly on an event keeps the ramp that ends there', () => {
  const { param, tracked: p } = tracked();
  // A loop boundary: the closing ramp and the next cycle's opening share one instant.
  p.setValueAtTime(1, 0);
  p.exponentialRampToValueAtTime(0.01, 1);
  p.setValueAtTime(1, 1);
  p.exponentialRampToValueAtTime(0.01, 2);

  expect(p.holdAt(1)).toBe(1);
  expect(param.ramps().slice(-2)).toEqual([
    { type: 'exponential', value: 0.01, time: 1 },
    { type: 'set', value: 1, time: 1 },
  ]);
  expect(p.valueAt(0.5)).toBeCloseTo(0.1);
});
