import { describe, expect, it } from 'vite-plus/test';
import { GrainPool } from '../engine/grain-pool.js';
import { makeParameters, setupProcessorGlobals, startProcessor } from './range-test-helpers';

setupProcessorGlobals();

describe('GrainPool', () => {
  it('fades each grain over its length in source samples at any rate', () => {
    const fade = new GrainPool();
    fade.current.position = 100;
    fade.fadeOut(-1, 8);
    expect(fade.outgoing(0).mix).toBe(0);
    fade.advance(2);
    expect(fade.outgoing(0).position).toBe(98);
    expect(fade.outgoing(0).mix).toBe(0.25);
    fade.advance(6);
    expect(fade.count).toBe(0);
  });

  it('keeps overlapping grains oldest first and drops finished ones', () => {
    const fade = new GrainPool();
    fade.current.position = 100;
    fade.fadeOut(1, 4);
    fade.advance(1);
    fade.current.position = 200;
    fade.fadeOut(1, 8, 1000);
    expect(fade.count).toBe(2);
    expect(fade.outgoing(1).position).toBe(200);
    fade.advance(3);
    expect(fade.count).toBe(1);
    expect(fade.outgoing(0)).toMatchObject({ position: 203, tailEnd: 1000, mix: 3 / 8 });
  });

  it('ignores fades shorter than a sample', () => {
    const fade = new GrainPool();
    fade.current.position = 100;
    fade.fadeOut(1, 0.5);
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
    { name: 'ping-pong turn', message: { type: 'voice:setLoopPingPong', value: true } },
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
      makeParameters({ trimEnd: 2000 / 48_000, loopEnd: 2000 / 48_000 }),
    );

    // A constant source stays constant through the crossfade
    expect(Math.min(...output.subarray(16))).toBeCloseTo(1, 4);
  });

  it('sizes a stretched loop-move fade from the grain rate, not the stretch transport rate', async () => {
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({
      type: 'voice:setBuffer',
      buffer: [new Float32Array(48_000).fill(0.5)],
      durationSeconds: 1,
    });
    send({
      type: 'voice:setPitchPeriods',
      periods: new Float32Array(101).fill(96),
      hopSamples: 480,
    });
    send({ type: 'voice:setTimestretchMode', value: 'period' });
    send({ type: 'voice:start', triggerId: 1 });

    // Enter a 6000-sample (0.125 s) time loop, then move it at playback rate 2.
    const initial = makeParameters({ playbackRate: 2, loopStart: 0, loopEnd: 0.125 });
    processor.process([], [[new Float32Array(100)]], initial);

    // Same length (0.125 s), moved start: wraps when originalSpeedPosition reaches 6000.
    const moved = makeParameters({ playbackRate: 2, loopStart: 0.25, loopEnd: 0.375 });
    processor.process([], [[new Float32Array(5901)]], moved);
    expect(processor.voice.grains.count).toBe(1);

    // 20 ms at 48 kHz = 960 output frames (1920 source samples at rate 2): still active halfway.
    processor.process([], [[new Float32Array(480)]], moved);
    expect(processor.voice.grains.count).toBe(1);

    processor.process([], [[new Float32Array(480)]], moved);
    expect(processor.voice.grains.count).toBe(0);
  });
});

// Covers LOOP_TURN_CROSSFADE; expected to fail with it off.
describe('loop turn crossfade', () => {
  it.each([0.5, 1, 1.5, 2])(
    'keeps the slope through a turn at buffer zero at rate %s',
    async (rate) => {
      // A nonzero offset and fractional reads exercise reflection around the first sample.
      const source = Float32Array.from(
        { length: 48_000 },
        (_, i) => 0.15 + 0.2 * Math.sin((2 * Math.PI * 220.3 * i) / 48_000),
      );
      const processor = await startProcessor();
      const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
      send({ type: 'voice:setBuffer', buffer: [source], durationSeconds: 1 });
      send({ type: 'voice:setLoopPingPong', value: true });
      send({ type: 'voice:start', triggerId: 1 });
      const output = new Float32Array(40_000);
      processor.process(
        [],
        [[output]],
        makeParameters({
          playbackRate: rate,
          loopStart: 0,
          loopEnd: 0.1,
          loopDurationDriftAmount: 0,
        }),
      );
      // First turn at the loop end, then back at buffer zero
      const turn = Math.ceil(9600 / rate) * 2;
      let curvature = 0;
      for (let i = turn - 4; i < turn + Math.ceil(256 / rate) + 4; i++) {
        curvature = Math.max(curvature, Math.abs(output[i] - 2 * output[i - 1] + output[i - 2]));
      }
      expect(curvature).toBeLessThan(0.002 * rate);
    },
  );

  it('rounds off the slope reversal of a ping-pong turn', async () => {
    const sine = Float32Array.from({ length: 48_000 }, (_, i) =>
      Math.sin((2 * Math.PI * 220.3 * i) / 48_000),
    );
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [sine], durationSeconds: 1 });
    send({ type: 'voice:setLoopPingPong', value: true });
    send({ type: 'voice:start', triggerId: 1 });
    const output = new Float32Array(20_000);
    processor.process(
      [],
      [[output]],
      makeParameters({ loopStart: 0.1, loopEnd: 0.2, loopDurationDriftAmount: 0 }),
    );

    // Second difference: a bare turn reverses the slope in one frame (~0.056 here)
    // Measure loop turns after the opening ramp.
    const settled = output.subarray(16);
    const curvature = settled
      .slice(2)
      .map((value, i) => Math.abs(value - 2 * settled[i + 1] + settled[i]));
    expect(Math.max(...curvature)).toBeLessThan(0.01);
  });
});
