import { describe, expect, it } from 'vite-plus/test';
import { makeParameters, setupProcessorGlobals, TEST_SAMPLE_RATE } from './range-test-helpers';

// A ramp buffer makes every output sample equal to the position it was read at,
// so a render trace is a trace of read positions.
const RAMP = Float32Array.from({ length: 2000 }, (_, i) => i / TEST_SAMPLE_RATE);
const toSeconds = (samples: number) => samples / TEST_SAMPLE_RATE;

type DirectionProcessor = {
  engine: { enableLoopCrossfade: boolean; isPlaying: boolean; startFadeFrames: number };
  port: { onmessage: ((event: MessageEvent) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: unknown): boolean;
};

async function startRamp(direction: 'forward' | 'reverse', loop = false, pingPong = false) {
  const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
  const processor = new SamplePlayerProcessor() as unknown as DirectionProcessor;
  processor.engine.enableLoopCrossfade = false;
  const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);

  send({
    type: 'voice:setBuffer',
    buffer: [RAMP],
    durationSeconds: RAMP.length / TEST_SAMPLE_RATE,
  });
  send({ type: 'voice:setLoopEnabled', value: loop });
  send({ type: 'voice:setLoopPingPong', value: pingPong });
  // The ramp reads back the playhead position only through linear interpolation.
  send({ type: 'voice:setInterpolation', value: 'linear' });
  send({ type: 'voice:setPlaybackDirection', playbackDirection: direction });
  send({ type: 'voice:start' });
  // Isolate source positions from the opening gain ramp.
  processor.engine.startFadeFrames = Infinity;
  return { processor, send };
}

/** Read positions, one per rendered sample, until the voice ends or `frames` run out. */
function trace(processor: DirectionProcessor, parameters: unknown, frames: number) {
  const positions: number[] = [];
  for (let frame = 0; frame < frames && processor.engine.isPlaying; frame++) {
    const out = new Float32Array(1);
    processor.process([], [[out]], parameters);
    if (processor.engine.isPlaying)
      positions.push(Math.round(out[0] * TEST_SAMPLE_RATE * 1000) / 1000);
  }
  return positions;
}

describe('playback direction', () => {
  setupProcessorGlobals();

  // Multiples of 375 samples (1/128 s) survive the float32 seconds round trip exactly.
  const trim = { trimStart: toSeconds(375), trimEnd: toSeconds(750) };

  // Trim and loop lengths stay above the ~92-sample minimum range.
  it('reverse reads exactly the positions forward reads, in reverse order', async () => {
    const forward = trace((await startRamp('forward')).processor, makeParameters(trim), 1000);
    const reverse = trace((await startRamp('reverse')).processor, makeParameters(trim), 1000);

    expect(forward[0]).toBe(375);
    expect(forward.at(-1)).toBe(749);
    expect(reverse).toEqual([...forward].reverse());
  });

  it.each([1, 0.75])('turns safely at both trim boundaries at rate %s', async (playbackRate) => {
    const params = makeParameters({ ...trim, playbackRate });
    for (const direction of ['forward', 'reverse'] as const) {
      const { processor, send } = await startRamp(direction);
      const frames =
        direction === 'forward'
          ? Math.ceil(375 / playbackRate)
          : Math.floor(374 / playbackRate) + 1;
      trace(processor, params, frames);
      send({
        type: 'voice:setPlaybackDirection',
        playbackDirection: direction === 'forward' ? 'reverse' : 'forward',
      });
      const after = trace(processor, params, 3);
      expect(after).toEqual(
        direction === 'forward'
          ? [749, 749 - playbackRate, 749 - 2 * playbackRate]
          : [375, 375 + playbackRate, 375 + 2 * playbackRate],
      );
    }
  });

  it('reads fractional positions at the playhead in both directions', async () => {
    const params = makeParameters({ ...trim, playbackRate: 0.75 });
    const reverse = trace((await startRamp('reverse')).processor, params, 4);

    expect(reverse).toEqual([749, 748.25, 747.5, 746.75]);
  });

  it('turns around on a direction change without repeating or skipping a sample', async () => {
    const { processor, send } = await startRamp('forward');
    const params = makeParameters(trim);

    const before = trace(processor, params, 10);
    send({ type: 'voice:setPlaybackDirection', playbackDirection: 'reverse' });
    const after = trace(processor, params, 3);

    expect(before.at(-1)).toBe(384);
    expect(after).toEqual([385, 384, 383]);
  });

  it('reverse from trim start 0 ends instead of restarting at the trim end', async () => {
    const { processor } = await startRamp('reverse');
    const params = makeParameters({ trimStart: 0, trimEnd: toSeconds(100) });
    const positions = trace(processor, params, 200);

    expect(positions.slice(-3)).toEqual([2, 1, 0]);
    expect(processor.engine.isPlaying).toBe(false);
  });

  it('a reverse loop cycles through the same positions as a forward loop', async () => {
    const loop = { loopStart: toSeconds(375), loopEnd: toSeconds(750), trimEnd: toSeconds(750) };
    const forward = trace((await startRamp('forward', true)).processor, makeParameters(loop), 1500);
    const reverse = trace((await startRamp('reverse', true)).processor, makeParameters(loop), 1500);

    const cycle = Array.from({ length: 375 }, (_, i) => 375 + i);
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    expect(sorted(forward.slice(-375))).toEqual(cycle);
    expect(sorted(reverse.slice(-375))).toEqual(cycle);
  });
});

// Loop [375, 750) samples; multiples of 375 are exact in float32 seconds.
describe('loop types', () => {
  setupProcessorGlobals();

  const LO = toSeconds(375);
  const HI = toSeconds(750);
  const trim = { trimStart: 0, trimEnd: toSeconds(1125) };
  const backward = makeParameters({ ...trim, loopStart: HI, loopEnd: LO });
  const forwardLoop = makeParameters({ ...trim, loopStart: LO, loopEnd: HI });
  const indexOfRun = (values: number[], run: number[]) =>
    values.findIndex((_, i) => run.every((v, j) => values[i + j] === v));

  it('backward: plays through the loop once, then cycles it backward', async () => {
    const positions = trace((await startRamp('forward', true)).processor, backward, 2000);

    // Forward from the trim start, turn at the loop end...
    expect(positions.slice(0, 3)).toEqual([0, 1, 2]);
    expect(indexOfRun(positions, [748, 749, 750, 749, 748])).toBe(748);
    // ...then jump from the loop start back to the loop end, every 375 samples
    const jump = indexOfRun(positions, [376, 375, 749, 748]);
    expect(jump).toBeGreaterThan(748);
    expect(positions.slice(jump + 2 + 375, jump + 2 + 377)).toEqual([749, 748]);
  });

  it('ping-pong: turns at both edges, cycle is twice the loop length', async () => {
    const positions = trace((await startRamp('forward', true, true)).processor, forwardLoop, 3000);

    // Each edge is read once per turn; the edges are 375 samples apart
    const tops = positions.flatMap((p, i) => (p === 750 ? [i] : []));
    const bottoms = positions.flatMap((p, i) => (p === 375 && i > 750 ? [i] : []));
    expect(indexOfRun(positions, [749, 750, 749, 748])).toBe(749);
    expect(indexOfRun(positions, [377, 376, 375, 376, 377])).toBe(tops[0] + 373);
    expect(bottoms[0] - tops[0]).toBe(375);
    expect(tops[1] - tops[0]).toBe(750);
  });

  it('ping-pong ignores loop point order', async () => {
    const ordered = trace((await startRamp('forward', true, true)).processor, forwardLoop, 2000);
    const inverted = trace((await startRamp('forward', true, true)).processor, backward, 2000);

    expect(inverted).toEqual(ordered);
  });

  it('reverse voice with inverted loop points cycles forward', async () => {
    const positions = trace((await startRamp('reverse', true)).processor, backward, 2500);

    expect(positions[0]).toBe(1124);
    expect(indexOfRun(positions, [376, 375, 376, 377])).toBeGreaterThan(0);
    const cycle = positions.slice(-375);
    expect([...cycle].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 375 }, (_, i) => 375 + i),
    );
    expect(cycle[1] - cycle[0]).toBe(1);
  });

  it('out of loop passes: turns back to the approach direction and plays out the tail', async () => {
    // Pass 1 ends at the turn, pass 2 at the first jump
    const params = makeParameters({ ...trim, loopStart: HI, loopEnd: LO, maxLoopCount: 2 });
    const { processor } = await startRamp('forward', true);
    const positions = trace(processor, params, 3000);

    expect(indexOfRun(positions, [376, 375, 749, 750, 751])).toBeGreaterThan(0);
    expect(positions.at(-1)).toBe(1124);
    expect(processor.engine.isPlaying).toBe(false);
  });

  it('a loop type change takes effect at the next loop edge', async () => {
    const { processor } = await startRamp('forward', true);
    trace(processor, backward, 900); // turned at 750, now cycling backward

    const positions = trace(processor, forwardLoop, 1000);

    // Keeps descending to the loop start, turns, then cycles forward
    expect(positions[1] - positions[0]).toBe(-1);
    const turn = indexOfRun(positions, [376, 375, 376]);
    expect(turn).toBeGreaterThan(0);
    expect(indexOfRun(positions.slice(turn), [748, 749, 375, 376])).toBeGreaterThan(0);
  });
});

describe('start from loop', () => {
  setupProcessorGlobals();

  // Multiples of 375 samples are exact in float32 seconds.
  const trim = { trimStart: toSeconds(375), trimEnd: toSeconds(1500) };
  const loop = { ...trim, loopStart: toSeconds(750), loopEnd: toSeconds(1125) };

  async function firstPositions(
    direction: 'forward' | 'reverse',
    loopOn: boolean,
    params: Record<string, number>,
  ) {
    const { processor, send } = await startRamp(direction, loopOn);
    send({ type: 'voice:setStartFromLoop', value: true });
    send({ type: 'voice:start' });
    processor.engine.startFadeFrames = Infinity;
    return trace(processor, makeParameters(params), 3);
  }

  it('starts at the lower loop point forward and before the higher one in reverse', async () => {
    expect(await firstPositions('forward', true, loop)).toEqual([750, 751, 752]);
    expect(await firstPositions('reverse', true, loop)).toEqual([1124, 1123, 1122]);
  });

  it('uses the same edges when loop points are inverted', async () => {
    const inverted = { ...loop, loopStart: loop.loopEnd, loopEnd: loop.loopStart };
    expect((await firstPositions('forward', true, inverted))[0]).toBe(750);
  });

  it('keeps the start inside trim', async () => {
    const outside = { ...trim, loopStart: 0, loopEnd: toSeconds(1875) };
    expect((await firstPositions('forward', true, outside))[0]).toBe(375);
    expect((await firstPositions('reverse', true, outside))[0]).toBe(1499);
  });

  it('starts at trim with looping off', async () => {
    expect(await firstPositions('forward', false, loop)).toEqual([375, 376, 377]);
  });
});
