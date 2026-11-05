import { describe, expect, it } from 'vite-plus/test';
import { LoopCrossfade } from '../engine/loop-crossfade.js';
import { makeParameters, setupProcessorGlobals, startProcessor } from './range-test-helpers';

setupProcessorGlobals();

describe('LoopCrossfade', () => {
  it('fades each head over its length in source samples at any rate', () => {
    const fade = new LoopCrossfade();
    fade.start(100, -1, 8, false, 1000);
    expect(fade.head(0).mix).toBe(0);
    fade.advance(2);
    expect(fade.head(0).position).toBe(98);
    expect(fade.head(0).mix).toBe(0.25);
    fade.advance(6);
    expect(fade.count).toBe(0);
  });

  it('keeps overlapping heads oldest first and drops finished ones', () => {
    const fade = new LoopCrossfade();
    fade.start(100, 1, 4, false, 1000);
    fade.advance(1);
    fade.start(200, 1, 8, true, 1000);
    expect(fade.count).toBe(2);
    expect(fade.head(1).position).toBe(200);
    fade.advance(3);
    expect(fade.count).toBe(1);
    expect(fade.head(0)).toMatchObject({ position: 203, fadesTail: true, mix: 3 / 8 });
  });

  it('ignores fades shorter than a sample', () => {
    const fade = new LoopCrossfade();
    fade.start(100, 1, 0.5, false, 1000);
    expect(fade.count).toBe(0);
  });
});

describe('loop jump crossfade', () => {
  it('continues the source past the loop end, then settles on the loop start', async () => {
    // Ramp 0..1 across the buffer: a jump from loop end to start is a large step.
    const ramp = Float32Array.from({ length: 48_000 }, (_, i) => i / 48_000);
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [ramp], durationSeconds: 1 });
    send({ type: 'voice:start', triggerId: 1 });
    const output = new Float32Array(7000);
    processor.process([], [[output]], makeParameters({ loopEnd: 0.125 }));

    const steps = output.slice(1).map((value, i) => Math.abs(value - output[i]));
    // No single-frame step anywhere near the 0.125 jump
    expect(Math.max(...steps)).toBeLessThan(0.01);
    // After the fade, playback reads the loop start again
    expect(output[6000 + 300]).toBeCloseTo(300 / 48_000, 4);
  });

  it.each([
    {
      name: 'reverse wrap',
      message: { type: 'voice:setPlaybackDirection', playbackDirection: 'reverse' },
    },
    { name: 'ping-pong turn', message: { type: 'setLoopPingPong', value: true } },
  ])('holds the first sample when reading before the buffer on a $name', async ({ message }) => {
    const source = new Float32Array(48_000).fill(1);
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [source], durationSeconds: 1 });
    send(message);
    send({ type: 'voice:start', triggerId: 1 });
    const output = new Float32Array(6000);
    processor.process(
      [],
      [[output]],
      makeParameters({ endPoint: 2000 / 48_000, loopEnd: 2000 / 48_000 }),
    );

    // A constant source stays constant through the crossfade
    expect(Math.min(...output)).toBeCloseTo(1, 4);
  });
});

// Covers LOOP_TURN_CROSSFADE; expected to fail with it off.
describe('loop turn crossfade', () => {
  it('rounds off the slope reversal of a ping-pong turn', async () => {
    const sine = Float32Array.from({ length: 48_000 }, (_, i) =>
      Math.sin((2 * Math.PI * 220.3 * i) / 48_000),
    );
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [sine], durationSeconds: 1 });
    send({ type: 'setLoopPingPong', value: true });
    send({ type: 'voice:start', triggerId: 1 });
    const output = new Float32Array(20_000);
    processor.process(
      [],
      [[output]],
      makeParameters({ loopStart: 0.1, loopEnd: 0.2, loopDurationDriftAmount: 0 }),
    );

    // Second difference: a bare turn reverses the slope in one frame (~0.056 here)
    const curvature = output
      .slice(2)
      .map((value, i) => Math.abs(value - 2 * output[i + 1] + output[i]));
    expect(Math.max(...curvature)).toBeLessThan(0.01);
  });
});
