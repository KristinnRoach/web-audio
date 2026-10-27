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

  it.each([
    {
      name: 'settled snapped loop',
      periods: [0.00390625, 0.0078125],
      end: 0.00390625,
      enabled: true,
      count: 0,
      step: 4,
    },
    {
      name: 'longest snap period',
      periods: [0.00390625, 0.0078125],
      end: 0.0078125,
      enabled: true,
      count: 0,
      step: 4,
    },
    {
      name: 'outside snap range',
      periods: [0.00390625, 0.0078125],
      end: 0.015625,
      enabled: true,
      count: 0,
      step: 8,
    },
    { name: 'no snap periods', periods: [], end: 0.00390625, enabled: true, count: 0, step: 8 },
    {
      name: 'loop disabled',
      periods: [0.00390625, 0.0078125],
      end: 0.00390625,
      enabled: false,
      count: 0,
      step: 8,
    },
    {
      name: 'loop passes exhausted',
      periods: [0.00390625, 0.0078125],
      end: 0.00390625,
      enabled: true,
      count: 1,
      step: 8,
    },
  ])(
    'applies source tuning only outside snapping: $name',
    async ({ periods, end, enabled, count, step }) => {
      const processor = await startProcessor([], periods);
      processor.port.onmessage?.({ data: { type: 'setPitchOffset', value: 12 } } as MessageEvent);
      processor.port.onmessage?.({
        data: { type: 'setLoopEnabled', value: enabled },
      } as MessageEvent);
      Object.assign(processor, { loopCount: count });

      render(
        processor,
        makeParameters({
          loopStart: 0,
          loopEnd: end,
          playbackRate: 2,
          detune: 1200,
          maxLoopCount: 1,
        }),
        1,
      );

      expect(processor.playbackPosition).toBe(step);
    },
  );

  it('keeps base tuning out of a snapped loop during glide and live tuning changes', async () => {
    const processor = await startProcessor([], [0.00390625, 0.0078125]);
    const parameters = makeParameters({ loopStart: 0, loopEnd: 0.0078125, playbackRate: 2 });
    render(processor, parameters, 1);

    parameters.loopEnd[0] = 0.00390625;
    for (const tuning of [12, -12]) {
      processor.port.onmessage?.({
        data: { type: 'setPitchOffset', value: tuning },
      } as MessageEvent);
      const previousPosition = processor.playbackPosition;
      render(processor, parameters, 1);
      expect(processor.playbackPosition - previousPosition).toBe(2);
    }
  });

  it('excludes base tuning when trim forces a shorter snapped target', async () => {
    const processor = await startProcessor([], [0.00390625, 0.0078125]);
    processor.port.onmessage?.({ data: { type: 'setPitchOffset', value: 12 } } as MessageEvent);
    render(processor, makeParameters({ loopStart: 0, loopEnd: 1, endPoint: 0.005 }), 1);
    expect(processor.playbackPosition).toBe(1);
  });

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

  it('posts each note’s first range with its trigger id, even if already posted', async () => {
    const processor = await startProcessor();
    const ranges = () =>
      processor.port.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message.type === 'loop:range');
    const r1 = makeParameters({ loopStart: 0, loopEnd: 0.5 });
    const start = (triggerId: number) =>
      processor.port.onmessage?.({ data: { type: 'voice:start', triggerId } } as MessageEvent);

    start(1);
    render(processor, r1, 1);
    start(2);
    render(processor, makeParameters({ loopStart: 0.25, loopEnd: 0.75 }), 1);
    start(3);
    render(processor, r1, 1);

    expect(ranges()).toMatchObject([
      { loopStart: 0, loopEnd: 0.5, triggerId: 1 },
      { loopStart: 0.25, loopEnd: 0.75, triggerId: 2 },
      { loopStart: 0, loopEnd: 0.5, triggerId: 3 },
    ]);
  });
});
