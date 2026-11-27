import { describe, expect, it } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

setupProcessorGlobals();

describe('pitch loop moves', () => {
  it('matches the unmoved voice when a tiny move coincides with a wrap', async () => {
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
          data: { type: 'voice:setLoopEnabled', value: true },
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
    processor.port.onmessage?.({
      data: { type: 'voice:setLoopEnabled', value: true },
    } as MessageEvent);
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

  it('follows a dragged pitch loop, a pass behind at most', async () => {
    const period = 192;
    const processor = await startProcessor([], [period / TEST_SAMPLE_RATE]);
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({
      type: 'voice:setBuffer',
      buffer: [Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) => Math.sin(i / 23) * 0.2)],
      durationSeconds: 1,
    });
    send({ type: 'voice:setLoopEnabled', value: true });
    send({ type: 'voice:start' });
    let start = 1000;
    for (let frame = 0; frame < 4000; frame++) {
      if (frame >= 1000) start += 0.5;
      processor.process(
        [],
        [[new Float32Array(1)]],
        makeParameters({
          loopStart: start / TEST_SAMPLE_RATE,
          loopEnd: (start + period) / TEST_SAMPLE_RATE,
        }),
      );
    }
    const position = processor.voice.playheadPosition;
    expect(position).toBeGreaterThanOrEqual(start - period);
    expect(position).toBeLessThanOrEqual(start + period);
  });

  it.each([
    { mode: 'forward', frames: 124 },
    { mode: 'forward', frames: 125 },
    { mode: 'reverse', frames: 251 },
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
            data: { type: 'voice:setLoopLengthGlide', value: 0 },
          } as MessageEvent);
          processor.port.onmessage?.({
            data: { type: 'voice:setLoopEnabled', value: true },
          } as MessageEvent);
          processor.port.onmessage?.({
            data: { type: 'voice:setLoopPingPong', value: mode === 'pingPong' },
          } as MessageEvent);
          processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
          return processor;
        }),
      );
      const parameters = (start: number, end: number) =>
        makeParameters({
          loopStart: (mode === 'reverse' ? end : start) / TEST_SAMPLE_RATE,
          loopEnd: (mode === 'reverse' ? start : end) / TEST_SAMPLE_RATE,
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

  it.each([1, 2])('applies a stereo move at the next wrap at rate %s', async (rate) => {
    const processor = await startProcessor([], [0.004, 0.008]);
    const left = Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) =>
      i < TEST_SAMPLE_RATE * 0.05 ? 0.4 : -0.4,
    );
    const right = Float32Array.from(left, (value) => (value > 0 ? -0.2 : 0.3));
    processor.port.onmessage?.({
      data: { type: 'voice:setBuffer', buffer: [left, right], durationSeconds: 1 },
    } as MessageEvent);
    processor.port.onmessage?.({
      data: { type: 'voice:setLoopEnabled', value: true },
    } as MessageEvent);
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
    // Mid-pass, the move waits for the edge
    const moved = render(0.1, 2);
    expect(moved[0][1]).toBe(before[0][31]);
    expect(moved[1][1]).toBe(before[1][31]);

    // From the next wrap on, each channel plays the new window
    const settled = render(0.1, 2048);
    expect(settled[0][2047]).toBeCloseTo(-0.4, 4);
    expect(settled[1][2047]).toBeCloseTo(0.3, 4);

    // Reusing the voice must not carry the previous note's loop into its attack.
    render(0, 1);
    processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
    const restarted = render(0, 17);
    expect(restarted[0][0]).toBe(0);
    expect(restarted[1][0]).toBeCloseTo(0, 6);
    expect(restarted[0][16]).toBeCloseTo(0.4);
    expect(restarted[1][16]).toBeCloseTo(-0.2);
  });
});
