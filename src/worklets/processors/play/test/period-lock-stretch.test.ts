import { describe, expect, it } from 'vite-plus/test';
import { PeriodLockStretcher } from '../engine/period-lock-stretch.js';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

setupProcessorGlobals();

const PERIOD = 96;
const END = 10_000;

function stretcher(period = PERIOD) {
  const stretch = new PeriodLockStretcher(1000);
  stretch.setPeriods(Float32Array.of(period), 1000);
  stretch.setEnabled(true, 0);
  return stretch;
}

const prepare = (stretch: PeriodLockStretcher, position: number, rate: number, end = END) =>
  stretch.prepareCorrection(true, position, rate, [], null, 0, end);

describe('PeriodLockStretcher', () => {
  it('waits for a full period of drift, then jumps whole periods and carries the phase', () => {
    const stretch = stretcher();
    expect(prepare(stretch, PERIOD, 1.5)).toBeNull();
    expect(prepare(stretch, PERIOD + 1, 1.5)).toEqual({
      outgoingPosition: PERIOD + 1,
      resetTarget: PERIOD + 1 + 1.5 - PERIOD,
    });
  });

  it('jumps forward when the rate is below one', () => {
    const stretch = stretcher();
    stretch.reset(500);
    expect(prepare(stretch, 500 - PERIOD - 1, 0.5)?.resetTarget).toBe(500 - 1 + 0.5);
  });

  it('skips a jump that would land outside the range', () => {
    expect(prepare(stretcher(), PERIOD + 1, 1.5, 1)).toBeNull();
  });

  it('uses short splices where no pitch is clear', () => {
    const stretch = stretcher(0);
    expect(prepare(stretch, 10, 2)).toBeNull();
    expect(prepare(stretch, 11, 2)?.resetTarget).toBe(3);
  });

  it('is inactive until it has periods, and for loops in the oscillator regime', () => {
    const stretch = new PeriodLockStretcher(1000);
    stretch.setEnabled(true, 0);
    expect(stretch.isActive([], false, 0, 100)).toBe(false);
    stretch.setPeriods(Float32Array.of(PERIOD), 1000);
    expect(stretch.isActive([], false, 0, 100)).toBe(true);
    expect(stretch.isActive([], true, 100, 100)).toBe(false);
    expect(stretch.isActive([], true, 101, 100)).toBe(true);
  });

  // At rate 8 jumps recur every 96 / 7 samples: half of that, not half a period.
  it.each([
    [1.5, 48],
    [8, 6],
  ])('caps the fade at rate %s to %s samples', (rate, expected) => {
    const stretch = stretcher();
    prepare(stretch, PERIOD + 1, rate);
    let frames = 0;
    while (stretch.outgoingPosition !== null) {
      stretch.advance(true, 0, rate, null, false, 0, END);
      frames++;
    }
    expect(frames).toBe(expected);
  });
});

describe('period timestretch through the processor', () => {
  const FRAMES = TEST_SAMPLE_RATE;

  async function renderSine(rate: number, loop = false) {
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    const sine = Float32Array.from(
      { length: FRAMES },
      (_, i) => 0.4 * Math.sin((2 * Math.PI * i) / PERIOD),
    );
    send({ type: 'voice:setBuffer', buffer: [sine], durationSeconds: 1 });
    send({ type: 'setLoopEnabled', value: loop });
    send({ type: 'setPanDriftEnabled', value: false });
    send({
      type: 'voice:setPitchPeriods',
      periods: new Float32Array(101).fill(PERIOD),
      hopSamples: 480,
    });
    send({ type: 'setTimestretchMode', value: 'period' });
    send({ type: 'voice:start', triggerId: 0 });

    const parameters = makeParameters({
      playbackRate: rate,
      ...(loop ? { loopEnd: 5000 / TEST_SAMPLE_RATE } : {}),
    });
    const rendered = new Float32Array(loop ? FRAMES / 2 : FRAMES - 2048);
    const block = new Float32Array(128);
    for (let frame = 0; frame + 128 <= rendered.length; frame += 128) {
      processor.process([], [[block]], parameters);
      rendered.set(block, frame);
    }
    return rendered;
  }

  function risingCrossings(samples: Float32Array, from: number, to: number) {
    let count = 0;
    for (let i = from; i < to; i++) if (samples[i - 1] < 0 && samples[i] >= 0) count++;
    return count;
  }

  // Includes non-integer ratios, which the experiment's repeats could not tune.
  it.each([2 ** (7 / 12), 2, 8])('keeps the pitch and the duration at rate %s', async (rate) => {
    const rendered = await renderSine(rate);
    const span = 24_000;
    const expected = (span / PERIOD) * rate;
    expect(Math.abs(risingCrossings(rendered, 2000, 2000 + span) - expected)).toBeLessThan(3);
    // Plain playback would have ended by FRAMES / rate.
    expect(Math.max(...rendered.subarray(FRAMES - 8000, FRAMES - 4000))).toBeGreaterThan(0.3);
  });

  it('jumps without clicks on a steady tone', async () => {
    const rate = 1.5;
    const rendered = await renderSine(rate);
    const steepest = 0.4 * ((2 * Math.PI) / PERIOD) * rate;
    let largest = 0;
    for (let i = 2000; i < 40_000; i++) {
      largest = Math.max(largest, Math.abs(rendered[i] - rendered[i - 1]));
    }
    expect(largest).toBeLessThan(steepest * 1.1);
  });

  it('keeps sounding in a loop across wraps', async () => {
    const rendered = await renderSine(1.5, true);
    expect(rendered.every(Number.isFinite)).toBe(true);
    expect(Math.max(...rendered.subarray(10_000, 20_000))).toBeGreaterThan(0.3);
  });
});
