import { describe, expect, it } from 'vite-plus/test';
import { makeParameters, setupProcessorGlobals, startProcessor } from './range-test-helpers';

setupProcessorGlobals();

// 6000-sample loop over a constant 0.2 (or -0.2) with a spike on the last loop
// sample, so every wrap jumps from ±0.8 back to ±0.2.
const LOOP_END = 0.125;
const LAST_LOOP_SAMPLE = 5999;

function spiked(level: number) {
  const channel = new Float32Array(48_000).fill(level);
  channel[LAST_LOOP_SAMPLE] = level * 4;
  return channel;
}

async function play(buffer: Float32Array[], frames: number, playbackRate = 1) {
  const processor = await startProcessor();
  const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
  send({ type: 'voice:setBuffer', buffer, durationSeconds: 1 });
  send({ type: 'voice:start', triggerId: 1 });
  const output = [new Float32Array(frames), new Float32Array(frames)];
  const parameters = makeParameters({ loopEnd: LOOP_END, playbackRate });
  processor.process([], [output], parameters);
  return { output, send, processor, parameters };
}

// The wrap frame lands halfway between the last emitted sample and the new source sample.
function expectHalfwayAt(channel: Float32Array, wrapFrame: number, incoming: number) {
  expect(channel[wrapFrame]).toBeCloseTo((channel[wrapFrame - 1] + incoming) / 2, 5);
}

describe('loop wrap compensation', () => {
  it.each([
    { frames: 2500, expected: 0 },
    { frames: 2385, expected: 0.4 * (30 / 64) },
  ])(
    'retains the old tail gain when relocating after $frames frames',
    async ({ frames, expected }) => {
      const processor = await startProcessor();
      const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
      send({
        type: 'voice:setBuffer',
        buffer: [new Float32Array(4800).fill(0.4), new Float32Array(4800)],
        durationSeconds: 0.1,
      });
      send({ type: 'setKeytrackLoopAmount', value: 1 });
      send({ type: 'voice:start' });
      processor.process(
        [],
        [[new Float32Array(frames), new Float32Array(frames)]],
        makeParameters({ loopEnd: 0.1, playbackRate: 2 }),
      );

      const output = [new Float32Array(1), new Float32Array(1)];
      processor.process(
        [],
        [output],
        makeParameters({ loopStart: 0.05, loopEnd: 0.06, playbackRate: 2 }),
      );
      // The new short loop has no padded tail. Relocation must restore the old
      // loop's audible continuation, including its silence or partial tail fade.
      expect(output[0][0]).toBeCloseTo(expected, 6);
      expect(output[1][0]).toBe(0);
    },
  );

  it.each([
    { direction: 'forward', wrapFrame: 4800, previous: 0, next: 0.22, settled: 0.4 },
    { direction: 'reverse', wrapFrame: 2400, previous: 0.4, next: 0.18, settled: 0 },
  ])(
    'smooths a $direction keytracked wrap across the silent tail',
    async ({ direction, wrapFrame, previous, next, settled }) => {
      const processor = await startProcessor();
      const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
      send({
        type: 'voice:setBuffer',
        buffer: [new Float32Array(4800).fill(0.4), new Float32Array(4800)],
        durationSeconds: 0.1,
      });
      send({ type: 'setKeytrackLoopAmount', value: 1 });
      send({ type: 'voice:setPlaybackDirection', playbackDirection: direction });
      send({ type: 'voice:start' });
      const output = [new Float32Array(wrapFrame + 128), new Float32Array(wrapFrame + 128)];
      // The correction must still pass through the musical envelope and master gain.
      processor.process(
        [],
        [output],
        makeParameters({ loopEnd: 0.1, playbackRate: 2, envGain: 0.5, masterGain: 0.5 }),
      );

      expect(output[0][wrapFrame - 1]).toBeCloseTo(previous * 0.25, 6);
      expect(output[0][wrapFrame]).toBeCloseTo(0.2 * 0.25, 6);
      expect(output[0][wrapFrame + 1]).toBeCloseTo(next * 0.25, 6);
      expect(output[0][wrapFrame + 127]).toBeCloseTo(settled * 0.25, 6);
      expect(output[1].every((value) => value === 0)).toBe(true);
    },
  );

  it('corrects both channels identically for a mono buffer', async () => {
    const { output } = await play([spiked(0.2)], 6100);
    const [left, right] = output;

    expectHalfwayAt(left, 6000, 0.2);
    expect(Array.from(right)).toEqual(Array.from(left));
  });

  it('corrects each channel of a stereo buffer toward its own step', async () => {
    const { output } = await play([spiked(0.2), spiked(-0.2)], 6100);
    const [left, right] = output;

    expectHalfwayAt(left, 6000, 0.2);
    expectHalfwayAt(right, 6000, -0.2);
    expect(right[6000]).toBeCloseTo(-left[6000], 6);
  });

  it('measures the step from interpolated samples at fractional rates', async () => {
    // Two frames per source sample: the wrap lands on frame 12000.
    const { output } = await play([spiked(0.2)], 12_100, 0.5);

    expect(output[0][11_999]).not.toBeCloseTo(0.8, 2); // interpolated, not the raw spike
    expectHalfwayAt(output[0], 12_000, 0.2);
  });

  it('starts a retriggered note without the previous note correction', async () => {
    const { send, processor, parameters } = await play([spiked(0.2)], 6001);

    send({ type: 'voice:stop' });
    send({ type: 'voice:start', triggerId: 2 });
    const output = [new Float32Array(1), new Float32Array(1)];
    processor.process([], [output], parameters);

    expect(output[0][0]).toBeCloseTo(0.2, 6);
    expect(output[1][0]).toBeCloseTo(0.2, 6);
  });

  it.each([0.01, 512])(
    'keeps wrap smoothing when moving by %s samples at the wrap',
    async (shift) => {
      const processor = await startProcessor([], [187.5 / 48_000]);
      const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
      const source = new Float32Array(48_000).fill(-0.4);
      source.fill(0.2, 0, 188);
      source[187] = 0.8;
      send({
        type: 'voice:setBuffer',
        buffer: [source, new Float32Array(48_000)],
        durationSeconds: 1,
      });
      send({ type: 'voice:start' });
      const before = [new Float32Array(188), new Float32Array(188)];
      processor.process([], [before], makeParameters({ loopEnd: 187.5 / 48_000 }));

      const after = [new Float32Array(1), new Float32Array(1)];
      processor.process(
        [],
        [after],
        makeParameters({ loopStart: shift / 48_000, loopEnd: (187.5 + shift) / 48_000 }),
      );

      // Relocation restores the old loop's incoming 0.2; wrap smoothing eases
      // the remaining 0.8 -> 0.2 step, without correcting relocation twice.
      expect(before[0][187]).toBeCloseTo(0.8, 6);
      expect(after[0][0]).toBeCloseTo(0.5, 5);
      expect(after[1][0]).toBe(0);
    },
  );
});
