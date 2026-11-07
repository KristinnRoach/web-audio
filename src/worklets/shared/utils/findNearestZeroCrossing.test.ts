import { expect, it } from 'vite-plus/test';
import { findNearestSlopeMatchedZeroCrossing } from './findNearestZeroCrossing.js';

const samples = Float32Array.from({ length: 17 }, (_, i) => Math.sin((2 * Math.PI * i) / 8));
const crossings = [0, 4, 8, 12, 16]; // 0, 8 and 16 rise; 4 and 12 fall

it('skips nearer crossings with the opposite slope', () => {
  expect(findNearestSlopeMatchedZeroCrossing(crossings, samples, 5, 8, 5)).toBe(8);
  expect(findNearestSlopeMatchedZeroCrossing(crossings, samples, 5, 12, 5)).toBe(4);
});

it('returns null when no match is within maxDistance or there is nothing to search', () => {
  expect(findNearestSlopeMatchedZeroCrossing(crossings, samples, 5, 8, 2)).toBeNull();
  expect(findNearestSlopeMatchedZeroCrossing([], samples, 5, 8, 5)).toBeNull();
});
