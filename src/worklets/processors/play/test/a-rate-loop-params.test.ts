import { describe, expect, it, vi } from 'vite-plus/test';
import { SAMPLE_PLAYER_WORKLET_AUDIOPARAMS } from '../sample-player-paramdescriptors';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

setupProcessorGlobals();

async function makeProcessor() {
  const processor = await startProcessor([], [0.002, 0.004, 0.008]);
  Object.assign(processor.engine, { enableLoopCrossfade: false });
  processor.port.onmessage?.({
    data: {
      type: 'voice:setBuffer',
      buffer: [Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) => Math.sin(i / 23) * 0.2)],
      durationSeconds: 1,
    },
  } as MessageEvent);
  processor.port.onmessage?.({ data: { type: 'setLoopEnabled', value: true } } as MessageEvent);
  processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
  return processor;
}

describe('a-rate loop points and duration glide', () => {
  it('exposes loop points as a-rate while trim stays k-rate', () => {
    expect(SAMPLE_PLAYER_WORKLET_AUDIOPARAMS.loopStart.automationRate).toBe('a-rate');
    expect(SAMPLE_PLAYER_WORKLET_AUDIOPARAMS.loopEnd.automationRate).toBe('a-rate');
    expect(SAMPLE_PLAYER_WORKLET_AUDIOPARAMS.startPoint.automationRate).toBe('k-rate');
    expect(SAMPLE_PLAYER_WORKLET_AUDIOPARAMS.endPoint.automationRate).toBe('k-rate');
  });

  it.each(
    [0, 0.01].flatMap((lengthGlideSeconds) =>
      ['forward', 'reverse', 'backward', 'pingPong'].map((mode) => ({ mode, lengthGlideSeconds })),
    ),
  )(
    'renders the same moving $mode loop in blocks and samples with length glide $lengthGlideSeconds',
    async ({ mode, lengthGlideSeconds }) => {
      const block = await makeProcessor();
      const singles = await makeProcessor();
      for (const processor of [block, singles]) {
        processor.port.onmessage?.({
          data: { type: 'setLoopLengthGlide', value: lengthGlideSeconds },
        } as MessageEvent);
        if (mode === 'reverse') {
          processor.port.onmessage?.({
            data: { type: 'voice:setPlaybackDirection', playbackDirection: 'reverse' },
          } as MessageEvent);
        }
        processor.port.onmessage?.({
          data: { type: 'setLoopPingPong', value: mode === 'pingPong' },
        } as MessageEvent);
      }
      for (let quantum = 0; quantum < 8; quantum++) {
        const params = makeParameters({ endPoint: 0.01 });
        params.loopStart = Float32Array.from({ length: 128 }, (_, i) => (quantum * 128 + i) / 1e7);
        params.loopEnd = Float32Array.from(
          params.loopStart,
          (start, i) => start + (i < 64 ? 0.002 : 0.004),
        );
        if (mode === 'backward')
          [params.loopStart, params.loopEnd] = [params.loopEnd, params.loopStart];
        const output = new Float32Array(128);
        block.process([], [[output]], params);
        const expected = new Float32Array(128);
        for (let i = 0; i < 128; i++) {
          const sampleParams = {
            ...params,
            loopStart: params.loopStart.slice(i, i + 1),
            loopEnd: params.loopEnd.slice(i, i + 1),
          };
          singles.process([], [[expected.subarray(i, i + 1)]], sampleParams);
        }
        expect(output.some((value) => value !== 0)).toBe(true);
        expect(output).toEqual(expected);
        expect(block.engine.playbackPosition).toBe(singles.engine.playbackPosition);
      }
    },
  );

  it('carries fractional wrap overshoot with a moving short loop', async () => {
    const moving = await makeProcessor();
    const fixed = await makeProcessor();
    const params = makeParameters({ playbackRate: 1.3, loopEnd: 0.004 });
    for (let frame = 0; frame < 1024; frame++) {
      const start = (frame * 0.25) / TEST_SAMPLE_RATE;
      fixed.process([], [[new Float32Array(1)]], params);
      const movingParams = makeParameters({
        playbackRate: 1.3,
        loopStart: start,
        loopEnd: start + 0.004,
      });
      moving.process([], [[new Float32Array(1)]], movingParams);
      const actualStart = (
        moving.engine as typeof moving.engine & {
          loopWindow: { start: number };
        }
      ).loopWindow.start;
      expect(moving.engine.playbackPosition - actualStart).toBeCloseTo(
        fixed.engine.playbackPosition,
        5,
      );
    }
  });

  it('keeps an existing backward turn when endpoints cross before the next edge', async () => {
    const processor = await makeProcessor();
    processor.port.onmessage?.({
      data: { type: 'setLoopLengthGlide', value: 0 },
    } as MessageEvent);
    const params = makeParameters({ loopStart: 0.002, loopEnd: 0 });
    processor.process([], [[new Float32Array(98)]], params);
    const state = processor.engine as typeof processor.engine & {
      loopTurned: boolean;
      loopCount: number;
    };
    expect(state.loopTurned).toBe(true);
    expect(state.loopCount).toBe(1);
    params.loopStart = Float32Array.from({ length: 16 }, (_, i) => (i < 8 ? 0.002 : 0));
    params.loopEnd = Float32Array.from({ length: 16 }, (_, i) => (i < 8 ? 0 : 0.002));
    processor.process([], [[new Float32Array(16)]], params);
    expect(state.loopTurned).toBe(true);
    expect(state.loopCount).toBe(1);
  });

  it('generates drift once before the first edge, even with per-sample point changes', async () => {
    const processor = await makeProcessor();
    const params = makeParameters({ loopDurationDriftAmount: 0.01 });
    params.loopStart = Float32Array.from({ length: 32 }, (_, i) => i / 1e7);
    params.loopEnd = Float32Array.from(params.loopStart, (start) => start + 0.004);
    const engine = processor.engine as typeof processor.engine & { random: () => number };
    const random = vi.spyOn(engine, 'random');
    processor.process([], [[new Float32Array(32)]], params);
    // One pitch-loop roll draws twice: loop drift, then its own pan drift.
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('rolls fresh drift on the first pass of every note', async () => {
    const processor = await makeProcessor();
    const params = makeParameters({ loopDurationDriftAmount: 0.01 });
    processor.process([], [[new Float32Array(1)]], params);
    processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
    const state = processor.engine as typeof processor.engine & {
      currentLoopDrift: number;
      loopDriftRolled: boolean;
    };
    state.currentLoopDrift = 12345; // stale drift from the previous note
    processor.process([], [[new Float32Array(1)]], params);
    expect(state.loopDriftRolled).toBe(true);
    expect(state.currentLoopDrift).not.toBe(12345);
  });

  it.each([0, 0.01])(
    'advances quantized glide by audible frames with length glide %f',
    async (lengthGlideSeconds) => {
      const processor = await makeProcessor();
      processor.port.onmessage?.({
        data: { type: 'setLoopLengthGlide', value: lengthGlideSeconds },
      } as MessageEvent);
      processor.process([], [[new Float32Array(1)]], makeParameters({ loopEnd: 0.002 }));
      processor.process([], [[new Float32Array(37)]], makeParameters({ loopEnd: 0.0075 }));
      const state = processor.engine as typeof processor.engine & {
        loopWindow: { length: number };
      };
      const expected =
        lengthGlideSeconds === 0
          ? 0.008
          : Math.exp(
              Math.log(0.008) +
                (Math.log(0.002) - Math.log(0.008)) *
                  Math.exp(-37 / TEST_SAMPLE_RATE / lengthGlideSeconds),
            );
      expect(state.loopWindow.length / TEST_SAMPLE_RATE).toBeCloseTo(expected, 10);
    },
  );

  it('applies a new length glide time constant during an active glide', async () => {
    const processor = await makeProcessor();
    processor.port.onmessage?.({
      data: { type: 'setLoopLengthGlide', value: 0.01 },
    } as MessageEvent);
    processor.process([], [[new Float32Array(1)]], makeParameters({ loopEnd: 0.002 }));
    const target = makeParameters({ loopEnd: 0.0075 });
    processor.process([], [[new Float32Array(37)]], target);
    processor.port.onmessage?.({
      data: { type: 'setLoopLengthGlide', value: 0.02 },
    } as MessageEvent);
    processor.process([], [[new Float32Array(19)]], target);
    const state = processor.engine as typeof processor.engine & {
      loopWindow: { length: number };
    };
    const expected = Math.exp(
      Math.log(0.008) +
        (Math.log(0.002) - Math.log(0.008)) *
          Math.exp(-37 / TEST_SAMPLE_RATE / 0.01 - 19 / TEST_SAMPLE_RATE / 0.02),
    );
    expect(state.loopWindow.length / TEST_SAMPLE_RATE).toBeCloseTo(expected, 10);
  });

  it('contains every modulated range inside trim without rounding fractional lengths', async () => {
    const processor = await startProcessor([], [100.5 / TEST_SAMPLE_RATE]);
    processor.port.onmessage?.({
      data: { type: 'setLoopLengthGlide', value: 0 },
    } as MessageEvent);
    const params = makeParameters({ startPoint: 0.001, endPoint: 0.01 });
    params.loopStart = Float32Array.from({ length: 128 }, (_, i) => i / 1000);
    params.loopEnd = Float32Array.from(
      params.loopStart,
      (start) => start + 100.5 / TEST_SAMPLE_RATE,
    );
    processor.process([], [[new Float32Array(128)]], params);
    const range = (
      processor.engine as typeof processor.engine & {
        loopWindow: {
          start: number;
          end: number;
          length: number;
        };
      }
    ).loopWindow;
    expect(range.start).toBeGreaterThanOrEqual(Math.floor(0.001 * TEST_SAMPLE_RATE));
    expect(range.end).toBeLessThanOrEqual(Math.floor(0.01 * TEST_SAMPLE_RATE));
    expect(range.length).toBeCloseTo(100.5, 7);
  });
});
