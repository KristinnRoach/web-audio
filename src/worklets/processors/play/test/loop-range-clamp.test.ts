import { describe, expect, it, vi } from 'vite-plus/test';
import {
  type TestProcessor,
  TEST_SAMPLE_RATE,
  makeParameters,
  startProcessor,
  render,
  setupProcessorGlobals,
} from './range-test-helpers';

// The loop is a subrange of the playback range: loop points clamp into it instead
// of being dropped for the whole range.
describe('loop range clamping', () => {
  setupProcessorGlobals();

  it.each([
    [0.25, 0.75],
    [0, 1],
    [0, 99_999],
  ])('keeps a long loop covering trim at %f..%f unsnapped', async (loopStart, loopEnd) => {
    const processor = await startProcessor([0.3, 0.7], [0.004, 0.01]);
    render(processor, makeParameters({ startPoint: 0.25, endPoint: 0.75, loopStart, loopEnd }), 1);
    const messages = processor.port.postMessage.mock.calls.map(([message]) => message);
    const loop = messages.find((message) => message.type === 'loop:range');
    const trim = messages.find((message) => message.type === 'trim:range');
    expect(loop.loopStart).toBe(trim.startPoint);
    expect(loop.loopEnd).toBe(trim.endPoint);
  });

  it('wraps to startPoint when loopStart sits before it', async () => {
    const processor = await startProcessor();
    // Default loopStart of 0 is outside a playback range starting at 0.5 s.
    const parameters = makeParameters({ startPoint: 0.5, endPoint: 1, loopEnd: 0.75 });

    render(processor, parameters, TEST_SAMPLE_RATE / 4 + 100);

    expect(processor.playbackPosition).toBeGreaterThanOrEqual(TEST_SAMPLE_RATE / 2);
    expect(processor.playbackPosition).toBeLessThan(TEST_SAMPLE_RATE / 2 + 200);
  });

  // The playback start snaps forward to a zero crossing, past a loop sitting on
  // the trim start. Clamping that loop would shorten it, and an audio-rate
  // loop's length is its pitch.
  it.each([92, 4800])(
    'keeps a %i-sample pitched loop at its length at the range start',
    async (loopLength) => {
      const start = TEST_SAMPLE_RATE / 2;
      const processor = await startProcessor(
        [(start + 20) / TEST_SAMPLE_RATE, 0.9],
        // The longest period sets the threshold; the loop's own length snaps to itself.
        loopLength > 92 ? [loopLength / TEST_SAMPLE_RATE, 0.101] : undefined,
      );
      const parameters = makeParameters({
        startPoint: start / TEST_SAMPLE_RATE,
        endPoint: 1,
        loopStart: start / TEST_SAMPLE_RATE,
        loopEnd: (start + loopLength) / TEST_SAMPLE_RATE,
      });

      const positions: number[] = [];
      for (let frame = 0; frame < loopLength * 4; frame++) {
        processor.process([], [[new Float32Array(1)]], parameters);
        positions.push(processor.playbackPosition);
      }

      // Distance between consecutive wraps is the loop length.
      const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
      expect(wraps.length).toBeGreaterThanOrEqual(2);
      expect(wraps[1] - wraps[0]).toBeCloseTo(loopLength, 0);
    },
  );

  it('keeps an audio-rate loop at its length when the range end moves before it', async () => {
    const end = TEST_SAMPLE_RATE * 0.75;
    const loopLength = 92;
    const processor = await startProcessor([0.5, (end - 20) / TEST_SAMPLE_RATE]);
    const parameters = makeParameters({
      startPoint: 0.5,
      endPoint: end / TEST_SAMPLE_RATE,
      loopStart: (end - loopLength) / TEST_SAMPLE_RATE,
      loopEnd: end / TEST_SAMPLE_RATE,
    });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE / 4 + loopLength * 3; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    expect(wraps[1] - wraps[0]).toBeCloseTo(loopLength, 0);
    // Never plays past the snapped range end (within Float32 parameter precision).
    expect(Math.max(...positions)).toBeLessThan(end - 20 + 1);
  });

  // Loop points arrive raw (web-audio#86), so a start past the end is just the
  // other order of the same two points.
  it('loops between inverted loop points', async () => {
    const processor = await startProcessor();
    const parameters = makeParameters({ endPoint: 1, loopStart: 0.75, loopEnd: 0.5 });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 1.3; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    expect(wraps[1] - wraps[0]).toBeCloseTo(TEST_SAMPLE_RATE / 4, -1);
  });

  // Inverted trim points play the range backward; the global reverse flag inverts that again.
  it.each([
    ['forward', true],
    ['reverse', false],
  ])('plays inverted trim points backward (global %s)', async (direction, backward) => {
    const length = TEST_SAMPLE_RATE * 0.4;
    const processor = await startProcessor();
    processor.port.onmessage?.({
      data: { type: 'voice:setPlaybackDirection', playbackDirection: direction },
    } as MessageEvent);
    const parameters = makeParameters({ startPoint: 0.9, endPoint: 0.5 });

    const positions: number[] = [];
    for (let frame = 0; frame < length * 3; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    expect(positions[1] < positions[0]).toBe(backward);
    const wraps = positions.flatMap((p, i) =>
      i > 0 && (backward ? p > positions[i - 1] : p < positions[i - 1]) ? [i] : [],
    );
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(wraps[1] - wraps[0] - length)).toBeLessThan(5);
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(TEST_SAMPLE_RATE / 2 - 1);
    expect(Math.max(...positions)).toBeLessThanOrEqual(TEST_SAMPLE_RATE * 0.9);
  });

  // Directional snaps clamp to the outermost crossing; a trim between two
  // crossings must not widen to them.
  it('keeps a trim between two zero crossings unsnapped', async () => {
    const processor = await startProcessor([0.5, 0.6]);
    const parameters = makeParameters({ startPoint: 0.55, endPoint: 0.56 });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 0.03; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    expect(Math.min(...positions)).toBeGreaterThanOrEqual(TEST_SAMPLE_RATE * 0.55 - 1);
    expect(Math.max(...positions)).toBeLessThanOrEqual(TEST_SAMPLE_RATE * 0.56 + 1);
  });

  // A loop above the audio-rate threshold snaps both ends inward to zero crossings.
  // With no crossing inside it, both ends used to land on the same one: a 1-sample loop.
  it('keeps a long loop with no zero crossing inside it at its length', async () => {
    const processor = await startProcessor([0.3, 0.5, 0.7]);
    const parameters = makeParameters({ endPoint: 1, loopStart: 0.45, loopEnd: 0.52 });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 0.8; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    // Snapping the start or the end to 0.5 would leave 20 or 50 ms, under the ~61 ms
    // threshold, so both ends stay unsnapped and the loop keeps its 70 ms.
    expect(Math.abs(wraps[1] - wraps[0] - TEST_SAMPLE_RATE * 0.07)).toBeLessThan(2);
  });

  // Zooming moves all points together every block. The playhead travels with an
  // audio-rate loop, so every cycle keeps the loop's length (its pitch) while it
  // moves, instead of shortening or stretching by the distance moved per block.
  it.each([-0.0005, 0.005, -0.005])(
    'keeps a moving audio-rate loop at its length (%f s per block)',
    async (perBlock) => {
      const loopLength = 96;
      const processor = (await startProcessor()) as TestProcessor & { loopCount: number };
      const at = (d: number) =>
        makeParameters({
          startPoint: 0.2 + d,
          endPoint: 0.9 + d,
          loopStart: 0.4 + d,
          loopEnd: 0.4 + d + loopLength / TEST_SAMPLE_RATE,
        });

      const block = 128;
      const counts: number[] = [];
      for (let k = 0; k < 340; k++) {
        const parameters = at(Math.max(0, k - 300) * perBlock);
        for (let i = 0; i < block; i++) {
          processor.process([], [[new Float32Array(1)]], parameters);
          counts.push(processor.loopCount);
        }
      }

      const wraps = counts.flatMap((c, i) => (i > 300 * block && c > counts[i - 1] ? [i] : []));
      const cycles = wraps.slice(1).map((w, i) => w - wraps[i]);
      expect(cycles.length).toBeGreaterThan(40);
      for (const cycle of cycles) expect(Math.abs(cycle - loopLength)).toBeLessThanOrEqual(1);
    },
  );

  // loop:range reports the resolved loop, not the raw points, and a change inside
  // the throttle window is posted once the window has passed.
  it('posts the resolved loop as loop:range', async () => {
    const processor = await startProcessor();
    const posts = () =>
      processor.port.postMessage.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg.type === 'loop:range');
    const min = processor.MIN_RANGE_SAMPLES / TEST_SAMPLE_RATE;

    // Zero-length loop lifts to the minimum range.
    render(processor, makeParameters({ endPoint: 1, loopStart: 0.5, loopEnd: 0.5 }), 1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].loopStart).toBeCloseTo(0.5, 4);
    expect(posts()[0].loopEnd).toBeCloseTo(0.5 + min, 4);

    const moved = makeParameters({ endPoint: 1, loopStart: 0.25, loopEnd: 0.5 });
    render(processor, moved, 1);
    expect(posts()).toHaveLength(1);

    vi.stubGlobal('currentTime', 1);
    render(processor, moved, 1);
    vi.stubGlobal('currentTime', 0);
    expect(posts()).toHaveLength(2);
    expect(posts()[1].loopStart).toBeCloseTo(0.25, 4);
    expect(posts()[1].loopEnd).toBeCloseTo(0.5, 4);
  });

  // trim:range reports the resolved trim: ordered, snapped inward to zero crossings.
  it('posts the resolved trim as trim:range', async () => {
    const processor = await startProcessor([0.3, 0.6]);
    render(processor, makeParameters({ startPoint: 0.7, endPoint: 0.2 }), 1);

    const posts = processor.port.postMessage.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg.type === 'trim:range');
    expect(posts).toHaveLength(1);
    expect(posts[0].startPoint).toBeCloseTo(0.3, 4);
    expect(posts[0].endPoint).toBeCloseTo(0.6, 4);
    expect(posts[0].inverted).toBe(true);
  });

  // Turning the loop off mid-note plays on through the rest of the trim range, then ends.
  it('plays to the range end after the loop is switched off', async () => {
    const processor = await startProcessor();
    const parameters = makeParameters({ endPoint: 0.75, loopStart: 0.25, loopEnd: 0.5 });
    render(processor, parameters, TEST_SAMPLE_RATE * 0.6);

    processor.port.onmessage?.({ data: { type: 'setLoopEnabled', value: false } } as MessageEvent);
    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 0.6; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.playbackPosition);
    }

    expect(Math.max(...positions)).toBeGreaterThan(TEST_SAMPLE_RATE * 0.74);
    const ended = processor.port.postMessage.mock.calls.filter(([m]) => m.type === 'voice:ended');
    expect(ended).toHaveLength(1);
  });
});
