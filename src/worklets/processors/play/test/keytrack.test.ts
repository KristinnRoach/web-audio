import { describe, expect, it } from 'vite-plus/test';
import { rateOctaves, trackOctaves } from '../engine/keytrack.js';
import {
  makeParameters,
  render,
  setupProcessorGlobals,
  startProcessor,
} from './range-test-helpers';

describe('keytrack', () => {
  setupProcessorGlobals();

  it('tracks exponentially in octaves of the note', () => {
    expect(rateOctaves(2)).toBe(1);
    expect(rateOctaves(-0.5)).toBe(-1);
    expect(trackOctaves(500, 1, 1)).toBe(1000);
    expect(trackOctaves(500, 0.5, 1)).toBeCloseTo(500 * Math.SQRT2);
    expect(trackOctaves(500, -1, 1)).toBe(250);
  });

  it('follows pitch modulation', async () => {
    const loopLength = async (detune: number) => {
      const processor = await startProcessor();
      processor.port.onmessage?.({
        data: { type: 'setKeytrackLoopAmount', value: 1 },
      } as MessageEvent);
      render(
        processor,
        makeParameters({ loopStart: 0.25, loopEnd: 0.5, playbackRate: 2, detune }),
        128,
      );
      const loop = processor.port.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === 'loop:range')
        .at(-1);
      return loop.loopEnd - loop.loopStart;
    };

    expect(await loopLength(0)).toBeCloseTo(0.5, 6);
    expect(await loopLength(-1200)).toBeCloseTo(0.25, 6);
  });
});
