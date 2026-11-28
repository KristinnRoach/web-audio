import { describe, expect, it } from 'vite-plus/test';
import { GrainPool, MAX_SPAWNED_GRAINS } from '../engine/grain-pool.js';
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

  it('spawns finite windowed grains with independent rate and pan until they expire', () => {
    const pool = new GrainPool();
    expect(pool.spawn(50, 1, 1.5, -0.5, 8, 2)).toBe(true);
    expect(pool.spawnedCount).toBe(1);
    expect(pool.spawned(0)).toMatchObject({ position: 50, rateRatio: 1.5, pan: -0.5, gain: 0 });

    // Halfway into fade-in (age 1 of 2): Hann ramp is 0.5; position advances by speed * rateRatio.
    pool.advance(2);
    expect(pool.spawned(0).position).toBeCloseTo(53, 6);
    expect(pool.spawned(0).gain).toBeCloseTo(0.5, 6);

    // Flat top (age 2..6): gain is 1.
    pool.advance(2);
    expect(pool.spawned(0).gain).toBeCloseTo(1, 6);

    // Advance to fade-out (age 7 of 8, remaining 1 of 2): gain is 0.5.
    for (let i = 0; i < 5; i++) pool.advance(2);
    expect(pool.spawned(0).gain).toBeCloseTo(0.5, 6);

    // One more frame expires and removes the grain.
    pool.advance(2);
    expect(pool.spawnedCount).toBe(0);
  });

  it('caps spawned grains at MAX_SPAWNED_GRAINS and keeps the pool non-silent while active', () => {
    const pool = new GrainPool();
    for (let i = 0; i < MAX_SPAWNED_GRAINS; i++) {
      expect(pool.spawn(i * 10, 1, 1, 0, 4, 1)).toBe(true);
    }
    expect(pool.spawn(999, 1, 1, 0, 4, 1)).toBe(false);
    expect(pool.spawnedCount).toBe(MAX_SPAWNED_GRAINS);

    pool.endCurrent();
    expect(pool.isSilent).toBe(false);
    for (let i = 0; i < 4; i++) pool.advance(1);
    expect(pool.isSilent).toBe(true);
  });
});

describe('spawned grains (numGrains)', () => {
  it('spawns staggered grains with independent stereo pan when numGrains > 1', async () => {
    const sine = Float32Array.from({ length: 48_000 }, (_, i) =>
      Math.sin((2 * Math.PI * 220 * i) / 48_000),
    );
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [sine], durationSeconds: 1 });
    send({ type: 'voice:setLoopEnabled', value: true });
    send({ type: 'voice:setPanDriftEnabled', value: false });
    send({ type: 'voice:setNumGrains', value: 3 });
    send({ type: 'voice:start', triggerId: 1 });

    const left = new Float32Array(6000);
    const right = new Float32Array(6000);
    processor.process(
      [],
      [[left, right]],
      makeParameters({ loopStart: 0, loopEnd: 0.5, loopDurationDriftAmount: 0 }),
    );

    // Playhead + 2 spawned grains active.
    expect(processor.voice.grains.spawnedCount).toBe(2);
    // Mono source with centered voice pan becomes stereo from per-grain pan offsets.
    let maxStereoDiff = 0;
    for (let i = 0; i < left.length; i++) {
      maxStereoDiff = Math.max(maxStereoDiff, Math.abs(left[i] - right[i]));
    }
    expect(maxStereoDiff).toBeGreaterThan(0.01);
  });

  it('lets existing spawned grains finish when numGrains drops back to 1', async () => {
    const source = new Float32Array(48_000).fill(0.5);
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [source], durationSeconds: 1 });
    send({ type: 'voice:setLoopEnabled', value: true });
    send({ type: 'voice:setNumGrains', value: 4 });
    send({ type: 'voice:start', triggerId: 1 });

    const params = makeParameters({ loopStart: 0, loopEnd: 0.5, loopDurationDriftAmount: 0 });
    processor.process([], [[new Float32Array(4000), new Float32Array(4000)]], params);
    expect(processor.voice.grains.spawnedCount).toBeGreaterThan(0);

    send({ type: 'voice:setNumGrains', value: 1 });
    // After one grain duration (100 ms = 4800 frames), all spawned grains have faded out.
    processor.process([], [[new Float32Array(5000), new Float32Array(5000)]], params);
    expect(processor.voice.grains.spawnedCount).toBe(0);
  });

  it('waits for spawned grains to finish fading before ending a one-shot note', async () => {
    const source = new Float32Array(48_000).fill(0.5);
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [source], durationSeconds: 1 });
    send({ type: 'voice:setLoopEnabled', value: false });
    send({ type: 'voice:setNumGrains', value: 2 });
    processor.port.postMessage.mockClear();
    send({ type: 'voice:start', triggerId: 7 });

    const endedIds = () =>
      processor.port.postMessage.mock.calls
        .map((call) => call[0] as { type: string; triggerId?: number })
        .filter((msg) => msg.type === 'voice:ended')
        .map((msg) => msg.triggerId);

    // Short 10 ms one-shot: playhead reaches trimEnd while the 100 ms spawned grain is still active.
    const params = makeParameters({ trimStart: 0, trimEnd: 0.01 });
    processor.process([], [[new Float32Array(1000), new Float32Array(1000)]], params);
    expect(processor.voice.grains.current.active).toBe(false);
    expect(processor.voice.grains.spawnedCount).toBe(1);
    expect(endedIds()).toEqual([]);

    // Once the spawned grain finishes its 100 ms window, the voice ends cleanly.
    processor.process([], [[new Float32Array(5000), new Float32Array(5000)]], params);
    expect(endedIds()).toEqual([7]);
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
