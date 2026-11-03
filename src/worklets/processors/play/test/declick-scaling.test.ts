import { expect, it, vi } from 'vite-plus/test';
import { makeParameters, setupProcessorGlobals, startProcessor } from './range-test-helpers';

const tuning = vi.hoisted(() => ({ amount: 0.5 }));
vi.mock('../declick-timing.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../declick-timing.js')>();
  return { getDeclickTiming: (rate: number) => original.getDeclickTiming(rate, tuning.amount) };
});
setupProcessorGlobals();

it.each([
  { amount: 0, scale: 0 },
  { amount: 0.5, scale: 1 },
  { amount: 0.75, scale: 10 },
])(
  'renders the silent-tail fade and reverse wrap at smoothing $amount',
  async ({ amount, scale }) => {
    tuning.amount = amount;
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
