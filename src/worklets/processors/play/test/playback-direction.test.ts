import { describe, expect, it } from 'vite-plus/test';
import { makeParameters, setupProcessorGlobals, TEST_SAMPLE_RATE } from './range-test-helpers';

// A ramp buffer makes every output sample equal to the position it was read at,
// so a render trace is a trace of read positions.
const RAMP = Float32Array.from({ length: 1000 }, (_, i) => i / TEST_SAMPLE_RATE);
const toSeconds = (samples: number) => samples / TEST_SAMPLE_RATE;

type DirectionProcessor = {
  enableLoopSmoothing: boolean;
  enableAmplitudeCompensation: boolean;
  isPlaying: boolean;
  port: { onmessage: ((event: MessageEvent) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: unknown): boolean;
};

async function startRamp(direction: 'forward' | 'reverse', loop = false) {
  const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
  const processor = new SamplePlayerProcessor() as unknown as DirectionProcessor;
  processor.enableLoopSmoothing = false;
  processor.enableAmplitudeCompensation = false;
  const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);

  send({
    type: 'voice:setBuffer',
    buffer: [RAMP],
    durationSeconds: RAMP.length / TEST_SAMPLE_RATE,
  });
  send({ type: 'setLoopEnabled', value: loop });
  send({ type: 'voice:setPlaybackDirection', playbackDirection: direction });
  send({ type: 'voice:start' });
  return { processor, send };
}

/** Read positions, one per rendered sample, until the voice ends or `frames` run out. */
function trace(processor: DirectionProcessor, parameters: unknown, frames: number) {
  const positions: number[] = [];
  for (let frame = 0; frame < frames && processor.isPlaying; frame++) {
    const out = new Float32Array(1);
    processor.process([], [[out]], parameters);
    if (processor.isPlaying) positions.push(Math.round(out[0] * TEST_SAMPLE_RATE * 1000) / 1000);
  }
  return positions;
}

describe('playback direction', () => {
  setupProcessorGlobals();

  const trim = { startPoint: toSeconds(100), endPoint: toSeconds(200) };

  // Trim and loop lengths stay above the ~92-sample minimum range.
  it('reverse reads exactly the positions forward reads, in reverse order', async () => {
    const forward = trace((await startRamp('forward')).processor, makeParameters(trim), 500);
    const reverse = trace((await startRamp('reverse')).processor, makeParameters(trim), 500);

    expect(forward[0]).toBe(100);
    expect(forward.at(-1)).toBe(199);
    expect(reverse).toEqual([...forward].reverse());
  });

  it('reads fractional positions at the playhead in both directions', async () => {
    const params = makeParameters({ ...trim, playbackRate: 0.75 });
    const reverse = trace((await startRamp('reverse')).processor, params, 4);

    expect(reverse).toEqual([199, 198.25, 197.5, 196.75]);
  });

  it('turns around on a direction change without repeating or skipping a sample', async () => {
    const { processor, send } = await startRamp('forward');
    const params = makeParameters(trim);

    const before = trace(processor, params, 10);
    send({ type: 'voice:setPlaybackDirection', playbackDirection: 'reverse' });
    const after = trace(processor, params, 3);

    expect(before.at(-1)).toBe(109);
    expect(after).toEqual([110, 109, 108]);
  });

  it('reverse from trim start 0 ends instead of restarting at the trim end', async () => {
    const { processor } = await startRamp('reverse');
    const params = makeParameters({ startPoint: 0, endPoint: toSeconds(100) });
    const positions = trace(processor, params, 200);

    expect(positions.slice(-3)).toEqual([2, 1, 0]);
    expect(processor.isPlaying).toBe(false);
  });

  it('a reverse loop cycles through the same positions as a forward loop', async () => {
    // Multiples of 375 samples (1/128 s) survive the float32 seconds round trip exactly.
    const loop = { loopStart: toSeconds(375), loopEnd: toSeconds(750), endPoint: toSeconds(750) };
    const forward = trace((await startRamp('forward', true)).processor, makeParameters(loop), 1500);
    const reverse = trace((await startRamp('reverse', true)).processor, makeParameters(loop), 1500);

    const cycle = Array.from({ length: 375 }, (_, i) => 375 + i);
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    expect(sorted(forward.slice(-375))).toEqual(cycle);
    expect(sorted(reverse.slice(-375))).toEqual(cycle);
  });
});
