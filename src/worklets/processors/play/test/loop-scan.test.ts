import { describe, expect, it } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
  type TestProcessor,
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
        processor.engine as typeof processor.engine & {
          loopWindow: { start: number; length: number };
        }
      ).loopWindow;
    };
    process(0, 0.004);
    const crossfadeCount = () =>
      (processor.engine as typeof processor.engine & { loopCrossfade: { count: number } })
        .loopCrossfade.count;
    return { process, crossfadeCount };
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

  it.each([
    ['start', { startPoint: 0.05 }, 0],
    ['end', { endPoint: 0.05 }, 4800],
  ])('keeps the loop length when trim %s moves past the glide', async (_, trim, settleFrames) => {
    const { process } = await setup(0.02);
    process(0.1, 0.104, settleFrames || 1);
    const range = process(0.1, 0.104, 1, trim);
    expect(range.length).toBeCloseTo(0.004 * TEST_SAMPLE_RATE, 3);
  });

  it('crossfades a trim-forced jump but not an ordinary glide step', async () => {
    const { process, crossfadeCount } = await setup(0.02);
    process(0.1, 0.104);
    expect(crossfadeCount()).toBe(0);
    process(0.1, 0.104, 1, { startPoint: 0.05 });
    expect(crossfadeCount()).toBe(1);
  });
});

describe('trim end moving under an outgoing crossfade head', () => {
  setupProcessorGlobals();
  const LEVEL = 0.5;
  const PLAYHEAD_OFFSET = 150; // inside the 192-sample loop

  async function moveTrimEnd(loopStart: number, offset: number, poke = false) {
    const processor = (await startProcessor([], [0.002, 0.004, 0.008])) as TestProcessor & {
      engine: {
        buffer: Float32Array[];
        loopWindow: { start: number };
        previousPlaybackPosition: number;
      };
    };
    const data = processor.engine.buffer[0];
    data.fill(LEVEL);
    const block = (trim = {}) => {
      const output = new Float32Array(128);
      const params = makeParameters({ loopStart, loopEnd: loopStart + 0.004, ...trim });
      processor.process([], [[output]], params);
      return output;
    };
    block(); // settle on the loop, so the only crossfade below is the trim-forced one
    block();
    const position = processor.engine.loopWindow.start + PLAYHEAD_OFFSET;
    processor.engine.playbackPosition = position;
    processor.engine.previousPlaybackPosition = position - 1;
    const trimEnd = position + offset;
    // Marks where a head would stick if it read up to the new trim end
    if (poke) data.fill(0, Math.floor(trimEnd) - 3, Math.ceil(trimEnd) + 2);
    return block({ endPoint: trimEnd / TEST_SAMPLE_RATE });
  }

  it.each([
    ['past the playhead', 0.1, -50],
    ['just ahead of the playhead', 0.1, 20],
    ['past the playhead, from the buffer end', 0.996, -50],
  ])('does not dip when trim end lands %s', async (_, loopStart, offset) => {
    const output = await moveTrimEnd(loopStart, offset);
    for (const value of output) expect(value).toBeCloseTo(LEVEL, 5);
  });

  it('reads the outgoing head up to the trim end it started with', async () => {
    const output = await moveTrimEnd(0.1, -50, true);
    expect(output[0]).toBeCloseTo(LEVEL, 5);
  });
});
