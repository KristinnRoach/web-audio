import { describe, expect, it } from 'vite-plus/test';
import { createScale } from '../../../../utils/music-theory/utils/scale-utils';
import {
  TEST_SAMPLE_RATE,
  makeParameters,
  startProcessor,
  render,
  setupProcessorGlobals,
} from './range-test-helpers';

describe('loop snapping and voice reuse', () => {
  setupProcessorGlobals();

  describe.each([0, 0.125])('with glide time constant %f', (ramp) => {
    it.each(['E', 'A', 'B'] as const)('snaps upward to the longest %s period', async (root) => {
      const periods = createScale(root, [0], 1, 5).periodsInSec.sort((a, b) => a - b);
      const longest = periods.at(-1)!;
      const processor = await startProcessor([], periods);
      processor.port.onmessage?.({
        data: { type: 'setLoopRampDuration', value: ramp },
      } as MessageEvent);
      render(processor, makeParameters({ loopStart: 0.5, loopEnd: 0.5 + 0.9 * longest }), 1);
      const loop = processor.port.postMessage.mock.calls
        .map(([message]) => message)
        .find((message) => message.type === 'loop:range');
      expect((loop.loopEnd - loop.loopStart) * TEST_SAMPLE_RATE).toBeCloseTo(
        longest * TEST_SAMPLE_RATE,
        7,
      );
    });
  });

  it('starts at trim after stopping and moving the previous note’s loop', async () => {
    const processor = await startProcessor();
    render(processor, makeParameters({ loopStart: 0, loopEnd: 0.002 }), 1);
    processor.port.onmessage?.({ data: { type: 'voice:stop' } } as MessageEvent);
    const parameters = makeParameters({ loopStart: 0.5, loopEnd: 0.502 });
    render(processor, parameters, 1);
    processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
    render(processor, parameters, 1);
    expect(processor.playbackPosition).toBe(1);
  });
});
