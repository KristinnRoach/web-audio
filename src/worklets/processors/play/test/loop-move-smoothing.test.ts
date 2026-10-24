import { describe, expect, it } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

setupProcessorGlobals();

describe('audio-rate loop movement smoothing', () => {
  it('does not read beyond the outgoing loop when a move coincides with a wrap', async () => {
    const period = 187.5;
    const processors = await Promise.all(
      [0, 1].map(async () => {
        const processor = await startProcessor([], [period / TEST_SAMPLE_RATE]);
        processor.port.onmessage?.({
          data: {
            type: 'voice:setBuffer',
            buffer: [
              Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) =>
                i < 188 ? 0.2 * Math.sin((2 * Math.PI * i) / period) : 0.8,
              ),
            ],
            durationSeconds: 1,
          },
        } as MessageEvent);
        processor.port.onmessage?.({
          data: { type: 'setLoopEnabled', value: true },
        } as MessageEvent);
        processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
        processor.process(
          [],
          [[new Float32Array(125)]],
          makeParameters({ playbackRate: 1.5, loopEnd: period / TEST_SAMPLE_RATE }),
        );
        return processor;
      }),
    );
    const output = processors.map((processor, i) => {
      const result = new Float32Array(1);
      processor.process(
        [],
        [[result]],
        makeParameters({
          playbackRate: 1.5,
          loopStart: (i * 0.01) / TEST_SAMPLE_RATE,
          loopEnd: (period + i * 0.01) / TEST_SAMPLE_RATE,
        }),
      );
      return result[0];
    });
    expect(output[0]).toBeCloseTo(0, 5);
    expect(output[1]).toBeCloseTo(output[0], 5);
  });

  it('keeps the waveform advancing during continuous a-rate movement', async () => {
    const processor = await startProcessor([], [0.004, 0.008]);
    processor.port.onmessage?.({
      data: {
        type: 'voice:setBuffer',
        buffer: [Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) => Math.sin(i / 23) * 0.2)],
        durationSeconds: 1,
      },
    } as MessageEvent);
    processor.port.onmessage?.({ data: { type: 'setLoopEnabled', value: true } } as MessageEvent);
    processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
    const params = makeParameters();
    params.loopStart = Float32Array.from({ length: 128 }, (_, i) => i / 1e7);
    params.loopEnd = Float32Array.from(params.loopStart, (start) => start + 0.004);
    const output = new Float32Array(128);
    processor.process([], [[output]], params);
    expect(Math.max(...output) - Math.min(...output)).toBeGreaterThan(0.3);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(output.slice(1).every((sample, i) => Math.abs(sample - output[i]) < 0.02)).toBe(true);
  });

  it.each([
    { mode: 'forward', frames: 124 },
    { mode: 'forward', frames: 125 },
    { mode: 'backward', frames: 251 },
    { mode: 'pingPong', frames: 124 },
    { mode: 'pingPong', frames: 125 },
  ])(
    'uses the outgoing $mode phase when shortening after $frames frames',
    async ({ mode, frames }) => {
      const processors = await Promise.all(
        [0, 1].map(async () => {
          const processor = await startProcessor([], [1 / 512, 1 / 256]);
          processor.port.onmessage?.({
            data: {
              type: 'voice:setBuffer',
              buffer: [
                Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) => Math.sin(i / 23) * 0.2),
              ],
              durationSeconds: 1,
            },
          } as MessageEvent);
          processor.port.onmessage?.({
            data: { type: 'setLoopRampDuration', value: 0 },
          } as MessageEvent);
          processor.port.onmessage?.({
            data: { type: 'setLoopEnabled', value: true },
          } as MessageEvent);
          processor.port.onmessage?.({
            data: { type: 'setLoopPingPong', value: mode === 'pingPong' },
          } as MessageEvent);
          processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
          return processor;
        }),
      );
      const parameters = (start: number, end: number) =>
        makeParameters({
          loopStart: (mode === 'backward' ? end : start) / TEST_SAMPLE_RATE,
          loopEnd: (mode === 'backward' ? start : end) / TEST_SAMPLE_RATE,
          playbackRate: 1.5,
        });

      for (const processor of processors) {
        processor.process([], [[new Float32Array(frames)]], parameters(0, 187.5));
      }
      const output = processors.map((processor, i) => {
        const result = new Float32Array(1);
        processor.process(
          [],
          [[result]],
          i === 0 ? parameters(0, 187.5) : parameters(11.71875, 105.46875),
        );
        return result[0];
      });

      // The move's first sample should match continuing the old loop, including
      // its wrap/turn when the preceding step already crossed the old edge.
      expect(output[1]).toBeCloseTo(output[0], 5);
    },
  );

  it.each([1, 2])(
    'smooths repeated stereo moves without changing phase at rate %s',
    async (rate) => {
      const processor = await startProcessor([], [0.004, 0.008]);
      const left = Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) =>
        i < TEST_SAMPLE_RATE * 0.05 ? 0.4 : -0.4,
      );
      const right = Float32Array.from(left, (value) => (value > 0 ? -0.2 : 0.3));
      processor.port.onmessage?.({
        data: { type: 'voice:setBuffer', buffer: [left, right], durationSeconds: 1 },
      } as MessageEvent);
      processor.port.onmessage?.({ data: { type: 'setLoopEnabled', value: true } } as MessageEvent);
      processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);

      const render = (start: number, length: number) => {
        const output = [new Float32Array(length), new Float32Array(length)];
        processor.process(
          [],
          [output],
          makeParameters({ loopStart: start, loopEnd: start + 0.004, playbackRate: rate }),
        );
        return output;
      };

      const before = render(0, 32);
      const moved = render(0.1, 2);
      expect(moved[0][0]).toBe(before[0][31]);
      expect(moved[1][0]).toBe(before[1][31]);
      expect(moved[0][1]).toBeCloseTo(-0.4 + 0.8 * 0.9);
      expect(moved[1][1]).toBeCloseTo(0.3 - 0.5 * 0.9);

      const movedAgain = render(0.2, 1);
      expect(movedAgain[0][0]).toBeCloseTo(-0.4 + 0.8 * 0.9 ** 2);
      expect(movedAgain[1][0]).toBeCloseTo(0.3 - 0.5 * 0.9 ** 2);
      const state = processor as typeof processor & {
        loopCount: number;
        previousLoopRange: { loopStartSamples: number; loopDurationSamples: number };
      };
      expect(state.loopCount).toBe(0);
      expect(state.previousLoopRange.loopDurationSamples).toBeCloseTo(192);
      expect(processor.playbackPosition - state.previousLoopRange.loopStartSamples).toBeCloseTo(
        35 * rate,
        4,
      );

      const settled = render(0.2, 128);
      expect(settled[0][127]).toBeCloseTo(-0.4, 4);
      expect(settled[1][127]).toBeCloseTo(0.3, 4);

      // Reusing the voice must not carry a previous note's correction into its attack.
      render(0, 1);
      processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
      const restarted = render(0, 1);
      expect(restarted[0][0]).toBeCloseTo(0.4);
      expect(restarted[1][0]).toBeCloseTo(-0.2);
    },
  );
});
