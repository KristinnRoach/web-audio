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
    send('setLoopLengthGlide', lengthGlideSeconds);
    if (positionGlideSeconds !== undefined) send('setLoopPositionGlide', positionGlideSeconds);
    const process = (start: number, end: number, frames = 1, trim = {}) => {
      const params = makeParameters({ loopStart: start, loopEnd: end, ...trim });
      processor.process([], [[new Float32Array(frames)]], params);
      return (
        processor as typeof processor & {
          previousLoopRange: { loopStartSamples: number; loopDurationSamples: number };
        }
      ).previousLoopRange;
    };
    process(0, 0.004);
    const crossfadeCount = () =>
      (processor as typeof processor & { loopCrossfade: { count: number } }).loopCrossfade.count;
    return { process, crossfadeCount };
  }

  it.each([0, 0.125])(
    'glides position independently of length timing %f',
    async (lengthGlideSeconds) => {
      const { process } = await setup(0.02, lengthGlideSeconds);
      const range = process(0.1, 0.104, 128);
      const target = new Float32Array([0.1])[0] * TEST_SAMPLE_RATE;
      expect(range.loopStartSamples).toBeCloseTo(
        target * (1 - Math.exp(-128 / TEST_SAMPLE_RATE / 0.02)),
        7,
      );
      expect(range.loopDurationSamples).toBeCloseTo(0.004 * TEST_SAMPLE_RATE, 7);
    },
  );

  it.each([undefined, 0])('moves instantly with position glide timing %s', async (duration) => {
    const { process } = await setup(duration, 0.125);
    expect(process(0.1, 0.104).loopStartSamples).toBeCloseTo(
      new Float32Array([0.1])[0] * TEST_SAMPLE_RATE,
      7,
    );
  });

  it('does not glide position for a start-only edit that keeps the quantized length', async () => {
    const { process } = await setup(0.02);
    expect(process(0.0001, 0.004).loopStartSamples).toBeCloseTo(
      new Float32Array([0.0001])[0] * TEST_SAMPLE_RATE,
      7,
    );
  });

  it.each([
    ['start', { startPoint: 0.05 }, 0],
    ['end', { endPoint: 0.05 }, 4800],
  ])('keeps the loop length when trim %s moves past the glide', async (_, trim, settleFrames) => {
    const { process } = await setup(0.02);
    process(0.1, 0.104, settleFrames || 1);
    const range = process(0.1, 0.104, 1, trim);
    expect(range.loopDurationSamples).toBeCloseTo(0.004 * TEST_SAMPLE_RATE, 3);
  });

  it('crossfades a trim-forced jump but not an ordinary glide step', async () => {
    const { process, crossfadeCount } = await setup(0.02);
    process(0.1, 0.104);
    expect(crossfadeCount()).toBe(0);
    process(0.1, 0.104, 1, { startPoint: 0.05 });
    expect(crossfadeCount()).toBe(1);
  });
});
