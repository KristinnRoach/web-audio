import { expect, it } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE as SR,
} from './range-test-helpers';

setupProcessorGlobals();

it('glides audio-rate pan drift without stepping the channel balance', async () => {
  const processor = await startProcessor();
  processor.port.onmessage?.({
    data: {
      type: 'voice:setBuffer',
      buffer: [new Float32Array(SR).fill(0.5)],
      durationSeconds: 1,
    },
  } as MessageEvent);
  processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);

  const parameters = makeParameters({ loopEnd: 0.005, loopDurationDriftAmount: 1 });
  const left = new Float32Array(1);
  const right = new Float32Array(1);
  let previousBalance = 0;
  let maxBalance = 0;
  let maxStep = 0;
  for (let frame = 0; frame < SR; frame++) {
    processor.process([], [[left, right]], parameters);
    const balance = left[0] - right[0];
    maxBalance = Math.max(maxBalance, Math.abs(balance));
    maxStep = Math.max(maxStep, Math.abs(balance - previousBalance));
    previousBalance = balance;
  }

  expect(maxBalance).toBeGreaterThan(0.1);
  expect(maxStep).toBeLessThan(0.005);
});
