import { afterAll, beforeAll, vi } from 'vite-plus/test';

export const TEST_SAMPLE_RATE = 48_000;

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

export type TestProcessor = {
  playbackPosition: number;
  MIN_RANGE_SAMPLES: number;
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

type Parameters = Record<string, Float32Array>;

/** Loop points default to the full 0..99999 s range, as the descriptors do. */
export function makeParameters(overrides: Record<string, number> = {}): Parameters {
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

export async function startProcessor(
  zeroCrossingSeconds: number[] = [],
  snapPeriodsSeconds?: number[],
) {
  const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
  const processor = new SamplePlayerProcessor() as unknown as TestProcessor;

  if (snapPeriodsSeconds !== undefined) {
    processor.port.onmessage?.({
      data: { type: 'setLoopSnapPeriods', value: snapPeriodsSeconds },
    } as MessageEvent);
  }

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

export function render(processor: TestProcessor, parameters: Parameters, frames: number) {
  for (let frame = 0; frame < frames; frame++) {
    processor.process([], [[new Float32Array(1)]], parameters);
  }
}

export function setupProcessorGlobals() {
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
}
