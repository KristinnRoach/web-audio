import { describe, expect, it, vi } from 'vite-plus/test';
import { PeriodLockStretcher } from '../engine/period-lock-stretch.js';
import { VoiceEngine } from '../engine/voice-engine.js';
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
  stretch.prepareJump(true, position, rate, 0, end);

describe('PeriodLockStretcher', () => {
  it('waits for a full period of drift, then jumps whole periods and carries the phase', () => {
    const stretch = stretcher();
    expect(prepare(stretch, PERIOD, 1.5)).toBeNull();
    expect(prepare(stretch, PERIOD + 1, 1.5)).toBe(PERIOD + 1 + 1.5 - PERIOD);
  });

  it('jumps forward when the rate is below one', () => {
    const stretch = stretcher();
    stretch.reset(500);
    expect(prepare(stretch, 500 - PERIOD - 1, 0.5)).toBe(500 - 1 + 0.5);
  });

  it('skips a jump that would land outside the range', () => {
    expect(prepare(stretcher(), PERIOD + 1, 1.5, 1)).toBeNull();
  });

  it('uses short splices where no pitch is clear', () => {
    const stretch = stretcher(0);
    expect(prepare(stretch, 10, 2)).toBeNull();
    expect(prepare(stretch, 11, 2)).toBe(3);
  });

  it('is inactive until it has periods, and for loops in the oscillator regime', () => {
    const stretch = new PeriodLockStretcher(1000);
    stretch.setEnabled(true, 0);
    expect(stretch.isActive(false, 0, 100)).toBe(false);
    stretch.setPeriods(Float32Array.of(PERIOD), 1000);
    expect(stretch.isActive(false, 0, 100)).toBe(true);
    expect(stretch.isActive(true, 100, 100)).toBe(false);
    expect(stretch.isActive(true, 101, 100)).toBe(true);
  });

  it('stretches only in period mode, so a removed mode name turns it off', () => {
    const engine = new VoiceEngine({ sampleRate: 1000, random: Math.random, post: () => {} });
    engine.setPitchPeriods(Float32Array.of(PERIOD), 1000);
    engine.setTimestretchMode('period');
    expect(engine.timestretch.isActive(false, 0, 100)).toBe(true);
    engine.setTimestretchMode('splice');
    expect(engine.timestretch.isActive(false, 0, 100)).toBe(false);
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
      stretch.advance(true, 0, rate, null);
      frames++;
    }
    expect(frames).toBe(expected);
  });
});

describe('period timestretch through the processor', () => {
  const FRAMES = TEST_SAMPLE_RATE;

  async function renderSine(
    rate: number,
    loop = false,
    loopPoints: { loopStart?: number; loopEnd?: number } = {},
    pingPong = false,
    onFrame?: (engine: VoiceEngine, frame: number) => void,
  ) {
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    const sine = Float32Array.from(
      { length: FRAMES },
      (_, i) => 0.4 * Math.sin((2 * Math.PI * i) / PERIOD),
    );
    send({ type: 'voice:setBuffer', buffer: [sine], durationSeconds: 1 });
    send({ type: 'setLoopEnabled', value: loop });
    send({ type: 'setLoopPingPong', value: pingPong });
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
      ...loopPoints,
    });
    const rendered = new Float32Array(onFrame ? 200_000 : loop ? FRAMES / 2 : FRAMES - 2048);
    const blockSize = onFrame ? 1 : 128;
    const block = new Float32Array(blockSize);
    for (let frame = 0; frame + blockSize <= rendered.length; frame += blockSize) {
      processor.process([], [[block]], parameters);
      rendered.set(block, frame);
      onFrame?.(processor.engine as unknown as VoiceEngine, frame);
    }
    return rendered;
  }

  function risingCrossings(samples: Float32Array, from: number, to: number) {
    let count: number | undefined = 0;
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

  function expectNoClicks(samples: Float32Array, rate: number, from: number, to: number) {
    const steepest = 0.4 * ((2 * Math.PI) / PERIOD) * rate;
    let largest = 0;
    for (let i = from; i < to; i++) {
      largest = Math.max(largest, Math.abs(samples[i] - samples[i - 1]));
    }
    expect(largest).toBeLessThan(steepest * 1.1);
  }

  it('jumps without clicks on a steady tone', async () => {
    expectNoClicks(await renderSine(1.5), 1.5, 2000, 40_000);
  });

  it('crosses the loop seam without clicks', async () => {
    expectNoClicks(await renderSine(2, true), 2, 2000, 20_000);
  });

  // The playhead position of each jump.
  async function renderRecordingJumps(...args: Parameters<typeof renderSine>) {
    const spy = vi.spyOn(PeriodLockStretcher.prototype, 'prepareJump');
    const rendered = await renderSine(...args);
    const jumps = spy.mock.calls
      .filter((_, call) => spy.mock.results[call].value !== null)
      .map(([, playbackPosition]) => playbackPosition);
    spy.mockRestore();
    return { rendered, jumps };
  }

  it.each([
    ['ping-pong', 0.5, true],
    ['ping-pong', 2, true],
    ['backward', 0.5, false],
    ['backward', 2, false],
  ] as const)('stretches inside a %s loop at rate %s', async (kind, rate, pingPong) => {
    const [low, high] = [2000 / TEST_SAMPLE_RATE, 7000 / TEST_SAMPLE_RATE];
    const points =
      kind === 'backward' ? { loopStart: high, loopEnd: low } : { loopStart: low, loopEnd: high };
    const { rendered, jumps } = await renderRecordingJumps(rate, true, points, pingPong);
    expect(jumps.length).toBeGreaterThan(20);
    expectNoClicks(rendered, rate, 12_000, 20_000);
  });

  describe('turns', () => {
    it.each([
      ['ping-pong', 0.5, 2],
      ['ping-pong', 2, 2],
      ['backward', 0.5, 1],
      ['backward', 2, 1],
    ] as const)('in a %s loop at rate %s', async (kind, rate, minTurns) => {
      const pingPong = kind === 'ping-pong';
      const [low, high] = [2000 / TEST_SAMPLE_RATE, 7000 / TEST_SAMPLE_RATE];
      const points = pingPong
        ? { loopStart: low, loopEnd: high }
        : { loopStart: high, loopEnd: low };
      const spy = vi.spyOn(PeriodLockStretcher.prototype, 'prepareJump');
      const rendered = await renderSine(rate, true, points, pingPong);
      const steps = spy.mock.calls.map(([, , playbackRate]) => playbackRate);
      spy.mockRestore();
      const turns = steps.filter((step, i) => i > 0 && step !== steps[i - 1]).length;
      expect(turns).toBeGreaterThanOrEqual(minTurns);
      expectNoClicks(rendered, rate, 12_000, 20_000);
    });
  });

  it.each([
    ['forward', 0.5],
    ['forward', 2],
    ['backward', 0.5],
    ['backward', 2],
    ['ping-pong', 0.5],
    ['ping-pong', 2],
  ] as const)('keeps unit-rate loop timing in %s mode at rate %s', async (kind, rate) => {
    const points =
      kind === 'backward'
        ? { loopStart: 7000 / TEST_SAMPLE_RATE, loopEnd: 2000 / TEST_SAMPLE_RATE }
        : { loopStart: 2000 / TEST_SAMPLE_RATE, loopEnd: 7000 / TEST_SAMPLE_RATE };
    async function edges(playbackRate: number) {
      const frames: number[] = [];
      let count: number | undefined = 0;
      await renderSine(playbackRate, true, points, kind === 'ping-pong', (engine, frame) => {
        if (engine.loopCount !== count) {
          frames.push(frame);
          count = engine.loopCount;
        }
      });
      return frames;
    }
    const reference = await edges(1);
    expect(reference.length).toBeGreaterThanOrEqual(4);
    expect(await edges(rate)).toEqual(reference);
  });

  it('stretches on the way into a loop that starts later', async () => {
    const loopStart = 20_000;
    const { jumps } = await renderRecordingJumps(2, true, {
      loopStart: loopStart / TEST_SAMPLE_RATE,
      loopEnd: 25_000 / TEST_SAMPLE_RATE,
    });
    expect(jumps.filter((position) => position < loopStart).length).toBeGreaterThan(20);
  });

  it('keeps sounding in a loop across wraps', async () => {
    const rendered = await renderSine(1.5, true);
    expect(rendered.every(Number.isFinite)).toBe(true);
    expect(Math.max(...rendered.subarray(10_000, 20_000))).toBeGreaterThan(0.3);
  });
});
