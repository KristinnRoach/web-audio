import { describe, expect, it } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

describe('loop position glide timing', () => {
  setupProcessorGlobals();

  async function setup(positionGlideSeconds?: number, lengthGlideSeconds = 0) {
    const processor = await startProcessor([], [0.002, 0.004, 0.008]);
    const send = (type: string, value: number) =>
      processor.port.onmessage?.({ data: { type, value } } as MessageEvent);
    send('voice:setLoopLengthGlide', lengthGlideSeconds);
    if (positionGlideSeconds !== undefined)
      send('voice:setLoopPositionGlide', positionGlideSeconds);
    const process = (start: number, end: number, frames = 1, trim = {}) => {
      const params = makeParameters({ loopStart: start, loopEnd: end, ...trim });
      processor.process([], [[new Float32Array(frames)]], params);
      return (
        processor.engine as typeof processor.engine & {
          loopWindow: { start: number; length: number };
        }
      ).loopWindow;
    };
    process(0, 0.004);
    const isMoveFading = () =>
      (processor.engine as typeof processor.engine & { loopMoveFadeLeft: number })
        .loopMoveFadeLeft > 0;
    return { process, isMoveFading };
  }

  it.each([0, 0.125])(
    'glides position independently of length timing %f',
    async (lengthGlideSeconds) => {
      const { process } = await setup(0.02, lengthGlideSeconds);
      const range = process(0.1, 0.104, 128);
      const target = new Float32Array([0.1])[0] * TEST_SAMPLE_RATE;
      expect(range.start).toBeCloseTo(target * (1 - Math.exp(-128 / TEST_SAMPLE_RATE / 0.02)), 7);
      expect(range.length).toBeCloseTo(0.004 * TEST_SAMPLE_RATE, 7);
    },
  );

  it.each([undefined, 0])('moves instantly with position glide timing %s', async (duration) => {
    const { process } = await setup(duration, 0.125);
    expect(process(0.1, 0.104).start).toBeCloseTo(new Float32Array([0.1])[0] * TEST_SAMPLE_RATE, 7);
  });

  it('does not glide position for a start-only edit that keeps the quantized length', async () => {
    const { process } = await setup(0.02);
    expect(process(0.0001, 0.004).start).toBeCloseTo(
      new Float32Array([0.0001])[0] * TEST_SAMPLE_RATE,
      7,
    );
  });
});
