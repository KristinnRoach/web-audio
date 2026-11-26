import { describe, expect, it, vi } from 'vite-plus/test';
import {
  type TestProcessor,
  TEST_SAMPLE_RATE,
  makeParameters,
  startProcessor,
  render,
  setupProcessorGlobals,
} from './range-test-helpers';

// The loop is a subrange of trim: loop points clamp into it instead
// of being dropped for the whole range.
describe('loop range clamping', () => {
  setupProcessorGlobals();

  it('reports pitch-loop eligibility only after playback enters the loop', async () => {
    const processor = await startProcessor();
    const parameters = makeParameters({ trimEnd: 1, loopStart: 0.1, loopEnd: 0.102 });
    const reports = () =>
      processor.port.postMessage.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg.type === 'loop:range');
    render(processor, parameters, 128);
    expect(reports().at(-1).isInPitchLoop).toBe(false);
    vi.stubGlobal('currentTime', 0.2);
    render(processor, parameters, TEST_SAMPLE_RATE / 5);
    expect(reports().at(-1).isInPitchLoop).toBe(true);
    vi.stubGlobal('currentTime', 0.4);
    render(processor, makeParameters({ loopStart: 0.1, loopEnd: 0.5 }), 128);
    expect(reports().at(-1).isInPitchLoop).toBe(false);
  });

  it.each([
    [0.25, 0.75],
    [0, 1],
    [0, 9999],
  ])('keeps a long loop covering trim at %f..%f unquantized', async (loopStart, loopEnd) => {
    const processor = await startProcessor([0.3, 0.7], [0.004, 0.01]);
    render(processor, makeParameters({ trimStart: 0.25, trimEnd: 0.75, loopStart, loopEnd }), 1);
    const messages = processor.port.postMessage.mock.calls.map(([message]) => message);
    const loop = messages.find((message) => message.type === 'loop:range');
    const trim = messages.find((message) => message.type === 'trim:range');
    expect(loop.loopStart).toBe(trim.trimStart);
    expect(loop.loopEnd).toBe(trim.trimEnd);
  });

  it('wraps to trimStart when loopStart sits before it', async () => {
    const processor = await startProcessor();
    // Default loopStart of 0 is outside a trim starting at 0.5 s.
    const parameters = makeParameters({ trimStart: 0.5, trimEnd: 1, loopEnd: 0.75 });

    render(processor, parameters, TEST_SAMPLE_RATE / 4 + 100);

    expect(processor.voice.playheadPosition).toBeGreaterThanOrEqual(TEST_SAMPLE_RATE / 2);
    expect(processor.voice.playheadPosition).toBeLessThan(TEST_SAMPLE_RATE / 2 + 200);
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
        // The longest period sets the threshold; the loop's own period quantizes to itself.
        loopLength > 92 ? [loopLength / TEST_SAMPLE_RATE, 0.101] : undefined,
      );
      const parameters = makeParameters({
        trimStart: start / TEST_SAMPLE_RATE,
        trimEnd: 1,
        loopStart: start / TEST_SAMPLE_RATE,
        loopEnd: (start + loopLength) / TEST_SAMPLE_RATE,
      });

      const positions: number[] = [];
      for (let frame = 0; frame < loopLength * 4; frame++) {
        processor.process([], [[new Float32Array(1)]], parameters);
        positions.push(processor.voice.playheadPosition);
      }

      // Distance between consecutive wraps is the loop length.
      const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
      expect(wraps.length).toBeGreaterThanOrEqual(2);
      expect(wraps[1] - wraps[0]).toBeCloseTo(loopLength, 0);
    },
  );

  it('keeps an audio-rate loop at its length when the range end snaps inside it', async () => {
    const end = TEST_SAMPLE_RATE * 0.75;
    const loopLength = 92;
    const processor = await startProcessor([0.5, (end - 20) / TEST_SAMPLE_RATE]);
    const parameters = makeParameters({
      trimStart: 0.5,
      trimEnd: end / TEST_SAMPLE_RATE,
      loopStart: (end - loopLength) / TEST_SAMPLE_RATE,
      loopEnd: end / TEST_SAMPLE_RATE,
    });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE / 4 + loopLength * 3; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.voice.playheadPosition);
    }

    const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    expect(wraps[1] - wraps[0]).toBeCloseTo(loopLength, 0);
  });

  // Loop points arrive raw (web-audio#86), so a start past the end selects the
  // same region. Inverted points make it a reverse loop: play through it once,
  // then cycle it in reverse (SFZ loop_type=backward).
  it('cycles inverted loop points in reverse over the same region', async () => {
    const processor = await startProcessor();
    const parameters = makeParameters({ trimEnd: 1, loopStart: 0.75, loopEnd: 0.5 });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 1.3; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.voice.playheadPosition);
    }

    // Jumps from the loop start back up to the loop end, one per reverse pass
    const jumps = positions.flatMap((p, i) => (i > 0 && p - positions[i - 1] > 1 ? [i] : []));
    expect(jumps.length).toBeGreaterThanOrEqual(2);
    expect(jumps[1] - jumps[0]).toBeCloseTo(TEST_SAMPLE_RATE / 4, -1);
    expect(positions.at(-1)! - positions.at(-2)!).toBeCloseTo(-1);
    expect(Math.min(...positions.slice(jumps[0]))).toBeGreaterThanOrEqual(
      TEST_SAMPLE_RATE * 0.5 - 1,
    );
    expect(Math.max(...positions)).toBeLessThanOrEqual(TEST_SAMPLE_RATE * 0.75);
  });

  // Inverted trim points play the range backward; the global reverse flag inverts that again.
  it.each([
    ['forward', -1],
    ['reverse', 1],
  ])('plays inverted trim points backward (global %s)', async (direction, step) => {
    const processor = await startProcessor();
    processor.port.onmessage?.({
      data: { type: 'voice:setPlaybackDirection', playbackDirection: direction },
    } as MessageEvent);
    const parameters = makeParameters({ trimStart: 0.875, trimEnd: 0.5 });

    render(processor, parameters, 1);
    const position = processor.voice.playheadPosition;
    render(processor, parameters, 1);
    expect(processor.voice.playheadPosition - position).toBeCloseTo(step);

    const trim = processor.port.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'trim:range');
    expect(trim.trimStart).toBe(0.5);
    expect(trim.trimEnd).toBe(0.875);
    expect(trim.inverted).toBe(true);
  });

  // Directional snaps clamp to the outermost crossing; a trim between two
  // crossings must not widen to them.
  it('keeps a trim between two zero crossings unsnapped', async () => {
    const processor = await startProcessor([0.5, 0.6]);
    const parameters = makeParameters({ trimStart: 0.55, trimEnd: 0.56 });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 0.03; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.voice.playheadPosition);
    }

    expect(Math.min(...positions)).toBeGreaterThanOrEqual(TEST_SAMPLE_RATE * 0.55 - 1);
    expect(Math.max(...positions)).toBeLessThanOrEqual(TEST_SAMPLE_RATE * 0.56 + 1);
  });

  // A loop above the audio-rate threshold snaps both ends inward to zero crossings.
  // With no crossing inside it, both ends used to land on the same one: a 1-sample loop.
  it('keeps a long loop with no zero crossing inside it at its length', async () => {
    const processor = await startProcessor([0.3, 0.5, 0.7]);
    // Straddle the 0.5 crossing so either snap would leave 0.6x the threshold.
    const half = (0.6 * processor.voice.pitchCutoff) / TEST_SAMPLE_RATE;
    const parameters = makeParameters({ trimEnd: 1, loopStart: 0.5 - half, loopEnd: 0.5 + half });

    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 0.8; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.voice.playheadPosition);
    }

    const wraps = positions.flatMap((p, i) => (i > 0 && p < positions[i - 1] ? [i] : []));
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    // Either snap would fall under the threshold, so both ends stay unsnapped.
    expect(Math.abs(wraps[1] - wraps[0] - 2 * half * TEST_SAMPLE_RATE)).toBeLessThan(2);
  });

  // Zooming moves all points together every block. The playhead travels with an
  // audio-rate loop, so every cycle keeps the loop's length (its pitch) while it
  // moves, instead of shortening or stretching by the distance moved per block.
  it.each([-0.0005, 0.005, -0.005])(
    'keeps a moving audio-rate loop at its length (%f s per block)',
    async (perBlock) => {
      const loopLength = 96;
      const processor = await startProcessor();
      const at = (d: number) =>
        makeParameters({
          trimStart: 0.2 + d,
          trimEnd: 0.9 + d,
          loopStart: 0.4 + d,
          loopEnd: 0.4 + d + loopLength / TEST_SAMPLE_RATE,
        });

      const block = 128;
      const phases: number[] = [];
      const output = [new Float32Array(1)];
      for (let k = 0; k < 340; k++) {
        const parameters = at(Math.max(0, k - 300) * perBlock);
        for (let i = 0; i < block; i++) {
          processor.process([], [output], parameters);
          const { playheadPosition, loopWindow } = processor.voice;
          // Measure wraps relative to the moving loop start.
          phases.push(playheadPosition - loopWindow.start);
        }
      }

      const wraps = phases.flatMap((phase, i) =>
        i > 300 * block && phase < phases[i - 1] ? [i] : [],
      );
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
    const min = processor.voice.minRangeSamples / TEST_SAMPLE_RATE;

    // Zero-length loop lifts to the minimum range.
    render(processor, makeParameters({ trimEnd: 1, loopStart: 0.5, loopEnd: 0.5 }), 1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].loopStart).toBeCloseTo(0.5, 4);
    expect(posts()[0].loopEnd).toBeCloseTo(0.5 + min, 4);

    const moved = makeParameters({ trimEnd: 1, loopStart: 0.25, loopEnd: 0.5 });
    render(processor, moved, 1);
    expect(posts()).toHaveLength(1);

    vi.stubGlobal('currentTime', 1);
    render(processor, moved, 1);
    vi.stubGlobal('currentTime', 0);
    expect(posts()).toHaveLength(2);
    expect(posts()[1].loopStart).toBeCloseTo(0.25, 4);
    expect(posts()[1].loopEnd).toBeCloseTo(0.5, 4);
  });

  it.each([
    ['forward', true, 0.25, 0.5, false],
    ['reverse', true, 0.5, 0.25, false],
    ['pingPong', true, 0.25, 0.5, true],
    ['forward', false, 0.25, 0.5, false],
    ['reverse', false, 0.5, 0.25, false],
    ['pingPong', false, 0.25, 0.5, true],
  ])(
    'reports loopMode %s on loop:range with looping %s',
    async (loopMode, loopEnabled, loopStart, loopEnd, pingPong) => {
      const processor = await startProcessor();
      processor.port.onmessage?.({
        data: { type: 'voice:setLoopEnabled', value: loopEnabled },
      } as MessageEvent);
      processor.port.onmessage?.({
        data: { type: 'voice:setLoopPingPong', value: pingPong },
      } as MessageEvent);
      render(processor, makeParameters({ trimEnd: 1, loopStart, loopEnd }), 1);

      const loop = processor.port.postMessage.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg.type === 'loop:range');
      expect(loop.loopMode).toBe(loopMode);
    },
  );

  // trim:range reports the resolved trim: ordered, snapped inward to zero crossings.
  it('posts the resolved trim as trim:range', async () => {
    const processor = await startProcessor([0.3, 0.6]);
    render(processor, makeParameters({ trimStart: 0.2, trimEnd: 0.7 }), 1);

    const posts = processor.port.postMessage.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg.type === 'trim:range');
    expect(posts).toHaveLength(1);
    expect(posts[0].trimStart).toBeCloseTo(0.3, 4);
    expect(posts[0].trimEnd).toBeCloseTo(0.6, 4);
  });

  // Turning the loop off mid-note plays on through the rest of the trim range, then ends.
  it('plays to the range end after the loop is switched off', async () => {
    const processor = await startProcessor();
    const parameters = makeParameters({ trimEnd: 0.75, loopStart: 0.25, loopEnd: 0.5 });
    render(processor, parameters, TEST_SAMPLE_RATE * 0.6);

    processor.port.onmessage?.({
      data: { type: 'voice:setLoopEnabled', value: false },
    } as MessageEvent);
    const positions: number[] = [];
    for (let frame = 0; frame < TEST_SAMPLE_RATE * 0.6; frame++) {
      processor.process([], [[new Float32Array(1)]], parameters);
      positions.push(processor.voice.playheadPosition);
    }

    expect(Math.max(...positions)).toBeGreaterThan(TEST_SAMPLE_RATE * 0.74);
    const ended = processor.port.postMessage.mock.calls.filter(([m]) => m.type === 'voice:ended');
    expect(ended).toHaveLength(1);
  });

  // ===== Loops outside trim =====

  const outside = { trimStart: 0.25, trimEnd: 0.5 };
  const pitchLoopAfter = { ...outside, loopStart: 0.75, loopEnd: 0.76 };
  const pitchLoopBefore = { ...outside, loopStart: 0.1, loopEnd: 0.11 };

  const messages = (processor: TestProcessor, type: string) =>
    processor.port.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === type);
  const send = (processor: TestProcessor, data: Record<string, unknown>) =>
    processor.port.onmessage?.({ data } as MessageEvent);

  it.each([
    ['after', pitchLoopAfter, 0.49, 0.5],
    ['before', pitchLoopBefore, 0.25, 0.26],
  ])(
    'clamps a pitch loop %s trim into trim while keeping its length',
    async (_, points, expectedStart, expectedEnd) => {
      const processor = await startProcessor();
      render(processor, makeParameters(points), 1);
      expect(messages(processor, 'trim:range')).toMatchObject([outside]);
      const loop = messages(processor, 'loop:range')[0];
      expect(loop.loopStart).toBeCloseTo(expectedStart, 5);
      expect(loop.loopEnd).toBeCloseTo(expectedEnd, 5);
    },
  );

  it('caps a pitch loop to the trim length when trim is narrower', async () => {
    const processor = await startProcessor([], [0.004, 0.01]);
    render(
      processor,
      makeParameters({ trimStart: 0.4, trimEnd: 0.405, loopStart: 0.4, loopEnd: 0.409 }),
      1,
    );
    const loop = messages(processor, 'loop:range')[0];
    expect(loop.loopStart).toBeCloseTo(0.4, 5);
    expect(loop.loopEnd).toBeCloseTo(0.405, 5);
  });

  // Pointer events arrive faster than the move fade; after 22 of them trim start passes
  // trim end and reverses playback.
  it.each(['trimStart', 'trimEnd'] as const)(
    'plays on without clicks when dragging %s pushes a sounding pitch loop',
    async (edge) => {
      const processor = await startProcessor([], [0.005, 0.0081, 0.012]);
      Object.assign(processor.voice, { enableLoopCrossfade: true });
      const wave = (_: unknown, i: number) => Math.sin(i / 20) * 0.2;
      send(processor, {
        type: 'voice:setBuffer',
        buffer: [Float32Array.from({ length: TEST_SAMPLE_RATE }, wave)],
        durationSeconds: 1,
      });
      send(processor, { type: 'voice:setStartFromLoop', value: true });
      send(processor, { type: 'voice:start' });
      processor.port.postMessage.mockClear(); // the buffer swap ended a note

      let previous = 0;
      let largestStep = 0;
      for (let block = 0; block < 0.5 * TEST_SAMPLE_RATE; block += 128) {
        const moved = Math.floor(block / 768) * 0.032;
        const trim = { trimStart: 0.1, trimEnd: 0.788 };
        trim[edge] += edge === 'trimStart' ? moved : -moved;
        const output = new Float32Array(128);
        const points = { ...trim, loopStart: 0.45, loopEnd: 0.4581 };
        processor.process([], [[output]], makeParameters(points));
        for (const value of output) {
          largestStep = Math.max(largestStep, Math.abs(value - previous));
          previous = value;
        }
      }
      expect(largestStep).toBeLessThan(0.02); // the source's own largest step is 0.01
      expect(messages(processor, 'voice:ended')).toHaveLength(0);
    },
  );

  it.each([
    ['forward', 2000],
    ['reverse', 3999],
  ])('starts %s on the keytracked loop', async (direction, position) => {
    const processor = await startProcessor([0, 4500 / TEST_SAMPLE_RATE, 1]);
    send(processor, { type: 'voice:setKeytrackLoopAmount', value: 1 });
    send(processor, { type: 'voice:setStartFromLoop', value: true });
    send(processor, { type: 'voice:setPlaybackDirection', playbackDirection: direction });
    const loop = { loopStart: 2000 / TEST_SAMPLE_RATE, loopEnd: 6000 / TEST_SAMPLE_RATE };
    const parameters = makeParameters({ trimEnd: 1, ...loop });
    parameters.playbackRate[0] = 0.5;
    render(processor, parameters, 1);
    expect(Math.abs(processor.voice.playheadPosition - position)).toBeLessThan(2);
  });

  it('keeps a note when trim reverses just after its pitch loop moved', async () => {
    const processor = await startProcessor(
      [],
      [395.5, 1000, 1200].map((period) => period / TEST_SAMPLE_RATE),
    );
    send(processor, { type: 'voice:setLoopLengthGlide', value: 0 });
    Object.assign(processor.voice, { enableLoopCrossfade: true });
    send(processor, { type: 'voice:setStartFromLoop', value: true });
    send(processor, { type: 'voice:start' });
    const points = (loopStart: number, loopEnd: number, trimStart = 0, trimEnd = 48000) =>
      makeParameters(
        Object.fromEntries(
          Object.entries({ loopStart, loopEnd, trimStart, trimEnd }).map(([name, samples]) => [
            name,
            samples / TEST_SAMPLE_RATE,
          ]),
        ),
      );
    render(processor, points(5000, 6000), 395);
    render(processor, points(6000, 7000), 1);
    processor.port.postMessage.mockClear();
    render(processor, points(8000, 8395.5, 14000, 8000), 2000);
    expect(messages(processor, 'voice:ended')).toHaveLength(0);
  });

  it('crossfades when trim pushes a gliding pitch loop', async () => {
    const processor = await startProcessor([], [200 / TEST_SAMPLE_RATE, 1000 / TEST_SAMPLE_RATE]);
    Object.assign(processor.voice, { enableLoopCrossfade: true });
    const source = (_: unknown, i: number) => (i < 5000 ? 0.5 : -0.5);
    send(processor, {
      type: 'voice:setBuffer',
      buffer: [Float32Array.from({ length: TEST_SAMPLE_RATE }, source)],
      durationSeconds: 1,
    });
    send(processor, { type: 'voice:setLoopPositionGlide', value: 0.125 });
    send(processor, { type: 'voice:setStartFromLoop', value: true });
    send(processor, { type: 'voice:start' });
    const at = (loopStart: number, trimStart: number) =>
      makeParameters({
        trimStart: trimStart / TEST_SAMPLE_RATE,
        loopStart: loopStart / TEST_SAMPLE_RATE,
        loopEnd: (loopStart + 200) / TEST_SAMPLE_RATE,
      });
    render(processor, at(1000, 0), 400);
    render(processor, at(10000, 0), 128);
    const output = new Float32Array(1);
    processor.process([], [[output]], at(10000, 6000));
    expect(output[0]).toBeGreaterThan(0.4);
    // Past the 20 ms move fade it plays only the new place.
    render(processor, at(10000, 6000), 2000);
    processor.process([], [[output]], at(10000, 6000));
    expect(output[0]).toBeCloseTo(-0.5, 5);
  });

  it('keeps a keytracked time loop start out of its silent tail', async () => {
    const start = 6000 / TEST_SAMPLE_RATE;
    const processor = await startProcessor([7500 / TEST_SAMPLE_RATE]);
    send(processor, { type: 'voice:setKeytrackLoopAmount', value: 1 });
    const points = { trimStart: start, trimEnd: 6750 / TEST_SAMPLE_RATE, loopEnd: 1 };
    const parameters = makeParameters(points);
    parameters.playbackRate[0] = 4;
    render(processor, parameters, 1);
    expect(messages(processor, 'loop:range')[0].loopStart).toBeCloseTo(start, 5);
  });

  it('rolls the first drift from the keytracked length when starting from the loop', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const processor = await startProcessor();
    send(processor, { type: 'voice:setKeytrackLoopAmount', value: 1 });
    send(processor, { type: 'voice:setStartFromLoop', value: true });
    const parameters = makeParameters({
      trimEnd: 1,
      loopStart: 0.2,
      loopEnd: 0.8,
      loopDurationDriftAmount: 0.3,
    });
    parameters.playbackRate[0] = 0.25;
    render(processor, parameters, 1);
    // 0.6 s keytracked to 0.15 s, less 26% (30% scaled down for its length).
    const loop = messages(processor, 'loop:range')[0];
    expect(loop.loopEnd - loop.loopStart).toBeCloseTo(0.1106, 3);
    vi.restoreAllMocks();
  });

  it('fades out when trim moves past the playhead', async () => {
    const processor = await startProcessor();
    send(processor, {
      type: 'voice:setBuffer',
      buffer: [new Float32Array(TEST_SAMPLE_RATE).fill(0.5)],
      durationSeconds: 1,
    });
    send(processor, { type: 'voice:setLoopEnabled', value: false });
    send(processor, { type: 'voice:start' });
    const parameters = makeParameters(outside);
    render(processor, parameters, 2400);
    processor.port.postMessage.mockClear(); // the buffer swap ended a note

    parameters.trimStart[0] = 0;
    parameters.trimEnd[0] = 0.1;
    const out: number[] = [0.5];
    for (let frame = 0; frame < 128; frame++) {
      const block = new Float32Array(1);
      processor.process([], [[block]], parameters);
      out.push(block[0]);
    }
    expect(out.at(-1)).toBe(0);
    const steps = out.slice(1).map((value, i) => Math.abs(value - out[i]));
    expect(Math.max(...steps)).toBeLessThan(0.02);
    expect(messages(processor, 'voice:ended')).toHaveLength(1);
  });

  it.each([
    ['after', 0.75, 1],
    ['before', 0, 0.2],
    ['mostly outside', 0.49, 0.8],
  ])('loops the whole trim when a time loop is %s it', async (_, loopStart, loopEnd) => {
    const processor = await startProcessor();
    render(processor, makeParameters({ ...outside, loopStart, loopEnd }), 1);
    expect(messages(processor, 'loop:range')[0]).toMatchObject({
      loopStart: outside.trimStart,
      loopEnd: outside.trimEnd,
      isInPitchLoop: false,
    });
  });
});
