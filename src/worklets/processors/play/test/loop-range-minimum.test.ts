import { describe, expect, it, vi } from 'vite-plus/test';
import {
  TEST_SAMPLE_RATE,
  makeParameters,
  startProcessor,
  render,
  setupProcessorGlobals,
} from './range-test-helpers';

describe('trim and loop minimum lengths', () => {
  setupProcessorGlobals();

  it('derives the crossover from periods and restores the default when cleared', async () => {
    const processor = await startProcessor();
    const defaultThreshold = processor.PITCH_PRESERVATION_THRESHOLD;
    expect(defaultThreshold).toBe(Math.floor(TEST_SAMPLE_RATE / 16.35));

    processor.port.onmessage?.({
      data: { type: 'setLoopSnapPeriods', value: [0.004, 0.01] },
    } as MessageEvent);
    expect(processor.PITCH_PRESERVATION_THRESHOLD).toBe(0.01 * TEST_SAMPLE_RATE);

    processor.port.onmessage?.({
      data: { type: 'setLoopSnapPeriods', value: [] },
    } as MessageEvent);
    expect(processor.PITCH_PRESERVATION_THRESHOLD).toBe(defaultThreshold);
  });

  it.each([
    [60, []], // Raw length above the scale range but below C5.
    [192, [0, 0.5 + 132 / TEST_SAMPLE_RATE, 0.504, 1]], // Start snap would leave 60 samples.
    [192, [0, 0.5, 0.5 + 60 / TEST_SAMPLE_RATE, 1]], // End snap would leave 60 samples.
  ])(
    'keeps a %i-sample ordinary loop above the minimum with a high-only scale',
    async (length, crossings) => {
      const processor = await startProcessor(crossings, [46 / TEST_SAMPLE_RATE]);
      render(
        processor,
        makeParameters({ loopStart: 0.5, loopEnd: 0.5 + length / TEST_SAMPLE_RATE }),
        1,
      );
      const loop = processor.port.postMessage.mock.calls
        .map(([message]) => message)
        .find((message) => message.type === 'loop:range');
      expect((loop.loopEnd - loop.loopStart) * TEST_SAMPLE_RATE).toBeGreaterThanOrEqual(
        processor.MIN_RANGE_SAMPLES - 1e-8,
      );
    },
  );

  describe.each([false, true])('clipping with scale enabled: %s', (withScale) => {
    it.each([
      [0.1, 0.5], // Partial overlap at the start.
      [0.5, 0.9], // Partial overlap at the end.
      [0.1, 0.2], // Entirely before trim.
      [0.8, 0.9], // Entirely after trim.
      [0.9, 0.1], // Inverted points covering trim.
    ])('keeps loop %f..%f above the minimum', async (loopStart, loopEnd) => {
      const processor = await startProcessor([], withScale ? [0.004, 0.06] : undefined);
      render(
        processor,
        makeParameters({ startPoint: 0.499, endPoint: 0.501, loopStart, loopEnd }),
        1,
      );
      const messages = processor.port.postMessage.mock.calls.map(([message]) => message);
      const loop = messages.find((message) => message.type === 'loop:range');
      const trim = messages.find((message) => message.type === 'trim:range');

      expect(loop.loopStart).toBeGreaterThanOrEqual(trim.startPoint);
      expect(loop.loopEnd).toBeLessThanOrEqual(trim.endPoint);
      expect((loop.loopEnd - loop.loopStart) * TEST_SAMPLE_RATE).toBeGreaterThanOrEqual(
        processor.MIN_RANGE_SAMPLES - 1e-8,
      );
    });
  });

  it.each([
    ['startPoint', 'endPoint', 'loopStart', 'loopEnd'],
    ['loopEnd', 'loopStart', 'endPoint', 'startPoint'],
  ])('respects the minimum while applying points in order %j', async (...order) => {
    const processor = await startProcessor([], [0.004, 0.06]);
    const values: Record<string, number> = {
      startPoint: 0.499,
      endPoint: 0.501,
      loopStart: 0.1,
      loopEnd: 0.2,
    };
    const parameters = makeParameters();
    try {
      for (const [index, key] of order.entries()) {
        parameters[key] = new Float32Array([values[key]]);
        vi.stubGlobal('currentTime', index + 1);
        render(processor, parameters, 1);
        const loop = processor.port.postMessage.mock.calls
          .map(([message]) => message)
          .filter((message) => message.type === 'loop:range')
          .at(-1);
        expect((loop.loopEnd - loop.loopStart) * TEST_SAMPLE_RATE).toBeGreaterThanOrEqual(
          processor.MIN_RANGE_SAMPLES - 1e-8,
        );
      }
    } finally {
      vi.stubGlobal('currentTime', 0);
    }
  });

  it.each([0.501, 0.503])(
    'fills trim ending at %f when a snapped period cannot fit, respecting the trim minimum',
    async (endPoint) => {
      const processor = await startProcessor([], [0.004]);
      render(
        processor,
        makeParameters({
          startPoint: 0.5,
          endPoint,
          loopStart: 0.5005,
          loopEnd: 0.5045,
        }),
        1,
      );

      const messages = processor.port.postMessage.mock.calls.map(([message]) => message);
      const loop = messages.find((message) => message.type === 'loop:range');
      const trim = messages.find((message) => message.type === 'trim:range');
      const expectedLength = Math.max(
        (endPoint - 0.5) * TEST_SAMPLE_RATE,
        processor.MIN_RANGE_SAMPLES,
      );

      expect(loop.loopStart).toBe(trim.startPoint);
      expect(loop.loopEnd).toBe(trim.endPoint);
      // Position params arrive as float32 seconds and trim resolves to source samples.
      expect(
        Math.abs((loop.loopEnd - loop.loopStart) * TEST_SAMPLE_RATE - expectedLength),
      ).toBeLessThan(1);
    },
  );

  // Equal trim points resolve to the minimum range.
  it.each([[0.5, 0.5]])(
    'resolves trim points %f..%f to the minimum range',
    async (startPoint, endPoint) => {
      const processor = await startProcessor();
      const length = processor.MIN_RANGE_SAMPLES;
      const parameters = makeParameters({ startPoint, endPoint });

      const positions: number[] = [];
      for (let frame = 0; frame < length * 3; frame++) {
        processor.process([], [[new Float32Array(1)]], parameters);
        positions.push(processor.playbackPosition);
      }

      const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
      expect(wraps.length).toBeGreaterThanOrEqual(2);
      // Trim points are floored to whole samples, so allow a few samples of slack.
      expect(Math.abs(wraps[1] - wraps[0] - length)).toBeLessThan(5);
      expect(Math.min(...positions)).toBeGreaterThanOrEqual(TEST_SAMPLE_RATE / 2);
    },
  );

  // Without snap periods a loop shorter than MIN_RANGE_SAMPLES lifts to it.
  it('lifts a 1-sample loop to the minimum range without snap periods', async () => {
    const start = TEST_SAMPLE_RATE / 2;
    const processor = await startProcessor();
    const minLength = processor.MIN_RANGE_SAMPLES;
    const parameters = makeParameters({
      endPoint: 1,
      loopStart: start / TEST_SAMPLE_RATE,
      loopEnd: (start + 1) / TEST_SAMPLE_RATE,
    });

    const positions: number[] = [];
    for (let frame = 0; frame < start + minLength * 4; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    // Fractional minimum, so wraps land on neighbouring whole samples.
    expect(Math.abs(wraps[1] - wraps[0] - minLength)).toBeLessThan(1);
  });

  // loopEnd dragged onto loopStart: the loop floors at 1 sample and snaps up to the
  // shortest allowed period, instead of falling back to the full playback range.
  it('snaps a zero-length loop to the shortest period', async () => {
    const shortestPeriod = 46;
    const processor = await startProcessor();
    processor.port.onmessage?.({
      data: { type: 'setLoopSnapPeriods', value: [shortestPeriod / TEST_SAMPLE_RATE, 0.01] },
    } as MessageEvent);
    const parameters = makeParameters({ loopStart: 0.5, loopEnd: 0.5 });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE / 2 + shortestPeriod * 4; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    expect(wraps[1] - wraps[0]).toBeCloseTo(shortestPeriod, 0);
    expect(Math.max(...positions)).toBeLessThan(TEST_SAMPLE_RATE / 2 + shortestPeriod + 1);
  });
});
