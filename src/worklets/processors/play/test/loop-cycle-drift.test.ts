import { expect, it, vi } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE as SR,
} from './range-test-helpers';

setupProcessorGlobals();

it.each([1, 128])('reports the incoming drifted cycle with %i-frame blocks', async (blockSize) => {
  // Alternate shorter and longer loops, without zero-crossing snapping.
  let roll = 0;
  const random = vi.spyOn(Math, 'random').mockImplementation(() => (roll++ % 2 ? 0.75 : 0.25));
  try {
    const processor = await startProcessor();
    const parameters = makeParameters({ loopEnd: 0.25, loopDurationDriftAmount: 0.1 });
    const output = [[new Float32Array(blockSize)]];
    for (let frame = 0; frame < SR; frame += blockSize) {
      vi.stubGlobal('currentFrame', frame);
      vi.stubGlobal('currentTime', frame / SR);
      processor.process([], output, parameters);
    }

    const cycles = processor.port.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'loop:cycle');
    expect(cycles.length).toBeGreaterThanOrEqual(3);
    expect(cycles[0].loopSeconds).toBeCloseTo(0.2625, 6);
    expect(cycles[1].loopSeconds).toBeCloseTo(0.2375, 6);
    // The reported boundary and duration must describe the following traversal.
    for (let index = 0; index < cycles.length - 1; index++) {
      expect(
        Math.abs(cycles[index + 1].time - cycles[index].time - cycles[index].loopSeconds),
      ).toBeLessThan(2 / SR);
    }
  } finally {
    random.mockRestore();
  }
});
