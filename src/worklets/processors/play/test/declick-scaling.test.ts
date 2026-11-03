import { expect, it, vi } from 'vite-plus/test';
import { makeParameters, setupProcessorGlobals, startProcessor } from './range-test-helpers';

const tuning = vi.hoisted(() => ({ wrap: 1, move: 1, tail: 1 }));
vi.mock('../declick-timing.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../declick-timing.js')>();
  return {
    getDeclickTiming: (rate: number) =>
      original.getDeclickTiming(rate, tuning.wrap, tuning.move, tuning.tail),
  };
});
setupProcessorGlobals();

it.each([0, 1, 10])(
  'renders the silent-tail fade and reverse wrap at duration scale %s',
  async (scale) => {
    tuning.wrap = scale;
    tuning.move = scale;
    tuning.tail = scale;
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({
      type: 'voice:setBuffer',
      buffer: [new Float32Array(4800).fill(0.4)],
      durationSeconds: 0.1,
    });
    send({ type: 'setKeytrackLoopAmount', value: 1 });
    send({ type: 'voice:start' });
    const parameters = makeParameters({ loopEnd: 0.1, playbackRate: 2 });
    const forward = new Float32Array(2401);
    processor.process([], [[forward]], parameters);
    // Position 4768 is 32 source samples from the audio end. Scaling duration
    // changes the ramp, while bypass still silences audio beyond its end.
    expect(forward[2384]).toBeCloseTo(scale === 0 ? 0.4 : 0.2 / scale, 6);
    expect(forward[2400]).toBe(0);

    send({ type: 'voice:setPlaybackDirection', playbackDirection: 'reverse' });
    send({ type: 'voice:start' });
    const reverse = new Float32Array(2402);
    processor.process([], [[reverse]], parameters);
    expect(reverse[2400]).toBeCloseTo(scale === 0 ? 0 : 0.2, 6);
    expect(reverse[2401]).toBeCloseTo(scale === 0 ? 0 : 0.2 * 0.9 ** (1 / scale), 6);
  },
);

it.each([false, true])(
  'accumulates relocation correction only for the lower endpoint (inverted=%s)',
  async (inverted) => {
    const offsets: number[] = [];
    for (const move of [0, 1, 10]) {
      for (const moveLower of [false, true]) {
        // Wrap and tail bypass must not disable independently tuned relocation.
        tuning.wrap = 0;
        tuning.tail = 0;
        tuning.move = move;
        const processor = await startProcessor();
        const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
        send({
          type: 'voice:setBuffer',
          buffer: [Float32Array.from({ length: 48_000 }, (_, i) => i / 1000)],
          durationSeconds: 1,
        });
        send({ type: 'voice:start' });
        const params = (lower: number, upper: number) =>
          makeParameters({
            loopStart: (inverted ? upper : lower) / 48_000,
            loopEnd: (inverted ? lower : upper) / 48_000,
            playbackRate: 2,
          });
        processor.process([], [[new Float32Array(100)]], params(128, 512));
        const output = new Float32Array(1);
        for (let i = 1; i <= 64; i++) {
          processor.process(
            [],
            [[output]],
            params(128 + (moveLower ? i / 10 : 0), 512 + (moveLower ? 0 : i / 10)),
          );
        }
        // No edge is reached in this render. The ramp's uncorrected source value
        // follows directly from the rendered position, exposing the added offset.
        const offset = output[0] - (processor.playbackPosition - 2) / 1000;
        if (!moveLower || move === 0) expect(offset).toBeCloseTo(0, 6);
        else offsets.push(Math.abs(offset));
      }
    }
    // With repeated same-sign jumps, 10x duration retains more of each correction.
    expect(offsets[1]).toBeGreaterThan(4 * offsets[0]);
  },
);
