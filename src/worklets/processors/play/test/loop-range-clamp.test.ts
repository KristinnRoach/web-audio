import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

const TEST_SAMPLE_RATE = 48_000;

type WorkletPort = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

class MockAudioWorkletProcessor {
  readonly port: WorkletPort = {
    onmessage: null,
    postMessage: vi.fn(),
  };
}

type TestProcessor = {
  playbackPosition: number;
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

type Parameters = Record<string, Float32Array>;

/** Loop points default to the full 0..99999 s range, as the descriptors do. */
function makeParameters(overrides: Record<string, number> = {}): Parameters {
  const values: Record<string, number> = {
    masterGain: 1,
    envGain: 1,
    velocity: 127,
    pan: 0,
    playbackRate: 1,
    loopStart: 0,
    loopEnd: 99_999,
    startPoint: 0,
    endPoint: 9999,
    playbackPosition: 0,
    loopDurationDriftAmount: 0,
    maxLoopCount: 999_999,
    tempo: 120,
    ...overrides,
  };

  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, new Float32Array([value])]),
  );
}

async function startProcessor(zeroCrossingSeconds: number[] = []) {
  const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
  const processor = new SamplePlayerProcessor() as unknown as TestProcessor;

  processor.port.onmessage?.({
    data: {
      type: 'voice:setBuffer',
      buffer: [new Float32Array(TEST_SAMPLE_RATE)],
      durationSeconds: 1,
    },
  } as MessageEvent);
  processor.port.onmessage?.({
    data: { type: 'voice:setZeroCrossings', zeroCrossings: zeroCrossingSeconds },
  } as MessageEvent);
  processor.port.onmessage?.({ data: { type: 'setLoopEnabled', value: true } } as MessageEvent);
  processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);

  return processor;
}

function render(processor: TestProcessor, parameters: Parameters, frames: number) {
  for (let frame = 0; frame < frames; frame++) {
    processor.process([], [[new Float32Array(1)]], parameters);
  }
}

// The loop is a subrange of the playback range: loop points clamp into it instead
// of being dropped for the whole range.
describe('loop range clamping', () => {
  beforeAll(() => {
    vi.stubGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
    vi.stubGlobal('sampleRate', TEST_SAMPLE_RATE);
    vi.stubGlobal('currentTime', 0);
    vi.stubGlobal('currentFrame', 0);
    vi.stubGlobal('registerProcessor', vi.fn());
  });

  afterAll(() => {
    vi.unstubAllGlobals();
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
  it('keeps an audio-rate loop at its length when the range start moves past it', async () => {
    const start = TEST_SAMPLE_RATE / 2;
    const loopLength = 92;
    const processor = await startProcessor([(start + 20) / TEST_SAMPLE_RATE, 0.9]);
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
  });

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
});
