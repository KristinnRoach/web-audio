import { describe, expect, it } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

setupProcessorGlobals();

// A ramp makes each rendered sample identify its absolute source position.
async function setup() {
  const processor = await startProcessor([], [0.002, 0.004, 0.008]);
  const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
  send({
    type: 'voice:setBuffer',
    buffer: [Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) => i / TEST_SAMPLE_RATE / 2)],
    durationSeconds: 1,
  });
  Object.assign(processor.engine, { enableLoopCrossfade: false });
  send({ type: 'setLoopLengthGlide', value: 0 });
  send({ type: 'voice:start' });
  const render = (start: number, length = 0.004, frames = 1) => {
    const output = new Float32Array(frames);
    processor.process(
      [],
      [[output]],
      makeParameters({ startPoint: 0.125, loopStart: start, loopEnd: start + length }),
    );
    return output[0];
  };
  render(0.125, 0.004, 32);
  render(0.25); // establish a nonzero window origin
  return { render, send };
}

describe('loop window coordinate transitions', () => {
  it('continues from the audible source position when looping is disabled', async () => {
    const { render, send } = await setup();
    send({ type: 'setLoopEnabled', value: false });
    expect(render(0.5)).toBeCloseTo((0.25 + 33 / TEST_SAMPLE_RATE) / 2, 7);
    expect(render(0.75)).toBeCloseTo((0.25 + 34 / TEST_SAMPLE_RATE) / 2, 7);
  });

  it('keeps source position on entering a time loop and offset on returning to pitch', async () => {
    const { render } = await setup();
    expect(render(0.25, 0.1)).toBeCloseTo((0.25 + 33 / TEST_SAMPLE_RATE) / 2, 7);
    // Returning to pitch preserves the offset within the preceding time window.
    expect(render(0.5)).toBeCloseTo((0.5 + 34 / TEST_SAMPLE_RATE) / 2, 7);
  });

  it('starts a reused voice at trim rather than the preceding window origin', async () => {
    const { render, send } = await setup();
    send({ type: 'voice:start' });
    expect(render(0.5)).toBeCloseTo(0.125 / 2, 7);
  });
});
