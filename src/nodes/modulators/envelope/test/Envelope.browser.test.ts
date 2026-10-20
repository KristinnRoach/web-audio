import { expect, test } from 'vite-plus/test';
import { Envelope } from '../Envelope';
import type { EnvelopeShape } from '../envelope-shape';

const SAMPLE_RATE = 48000;

/** Attack 0 -> 1 exponential over 20 ms, sustain at 1, linear release over 50 ms. */
const exponentialAttack: EnvelopeShape = {
  points: [
    { time: 0, value: 0, curve: 'exponential' },
    { time: 0.02, value: 1 },
    { time: 0.07, value: 0 },
  ],
  mode: { type: 'sustain' },
  sustainPoint: 1,
  releasePoint: 1,
};

/** Renders a param driven by `play` as a DC signal, so each sample is the param's value. */
async function render(play: (envelope: Envelope) => void, durationSeconds = 0.1) {
  const ctx = new OfflineAudioContext(1, SAMPLE_RATE * durationSeconds, SAMPLE_RATE);
  const source = new ConstantSourceNode(ctx, { offset: 0 });
  source.connect(ctx.destination);
  source.start();

  const envelope = new Envelope(ctx, source.offset, exponentialAttack);
  play(envelope);
  return { envelope, data: (await ctx.startRendering()).getChannelData(0) };
}

const sampleAt = (time: number) => Math.round(time * SAMPLE_RATE);

test('the tracked timeline matches what a real AudioParam renders', async () => {
  const times = [0.002, 0.005, 0.01, 0.015, 0.019];
  let expected: number[] = [];
  const { data } = await render((envelope) => {
    envelope.trigger(0);
    expected = times.map((time) => envelope.param.valueAt(time));
  });

  times.forEach((time, i) => expect(data[sampleAt(time)]).toBeCloseTo(expected[i], 3));
});

test('a release mid exponential attack hands off without a step', async () => {
  const releaseTime = 0.01;
  const { data } = await render((envelope) => {
    envelope.trigger(0);
    envelope.release(releaseTime);
  });

  // Halfway up an exponential ramp from the 1e-4 floor to 1 is 0.01, not the shape's 0.5.
  const at = sampleAt(releaseTime);
  expect(data[at]).toBeCloseTo(0.01, 3);
  const largestStep = Math.max(
    ...Array.from({ length: 20 }, (_, i) => Math.abs(data[at - 10 + i + 1] - data[at - 10 + i])),
  );
  expect(largestStep).toBeLessThan(0.001);
});
