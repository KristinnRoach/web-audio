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
        processor.voice as typeof processor.voice & {
          loopWindow: { start: number; length: number };
        }
      ).loopWindow;
    };
    process(0, 0.004);
    return { process };
  }

  it('glides position independently of length timing', async () => {
    const target = new Float32Array([0.1])[0] * TEST_SAMPLE_RATE;
    const runs = await Promise.all(
      [0, 0.125].map(async (lengthGlideSeconds) => {
        const { process } = await setup(0.02, lengthGlideSeconds);
        // Past the first 0.004 s pass, so the next one is latched mid-glide
        return process(0.1, 0.104, 256);
      }),
    );
    for (const range of runs) {
      expect(range.start).toBeGreaterThan(0);
      expect(range.start).toBeLessThan(target);
      expect(range.length).toBeCloseTo(0.004 * TEST_SAMPLE_RATE, 7);
    }
    expect(runs[1].start).toBeCloseTo(runs[0].start, 7);
  });

  it.each([undefined, 0])('moves instantly with position glide timing %s', async (duration) => {
    const { process } = await setup(duration, 0.125);
    expect(process(0.1, 0.104, 256).start).toBeCloseTo(
      new Float32Array([0.1])[0] * TEST_SAMPLE_RATE,
      7,
    );
  });

  it('does not glide position for a start-only edit that keeps the quantized length', async () => {
    const { process } = await setup(0.02);
    expect(process(0.0001, 0.004, 256).start).toBeCloseTo(
      new Float32Array([0.0001])[0] * TEST_SAMPLE_RATE,
      7,
    );
  });
});
