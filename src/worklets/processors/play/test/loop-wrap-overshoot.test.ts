import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

const TEST_SAMPLE_RATE = 48_000;
// Both loop lengths stay under the default pitchCutoff
// so no zero-crossing snapping runs against the silent test buffer.
const WIDE_LOOP_SAMPLES = 1000;
const NARROW_LOOP_SAMPLES = 100;

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
  voice: { enableLoopCrossfade: boolean; playheadPosition: number };
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

type Parameters = Record<string, Float32Array>;

function samplesToSeconds(samples: number) {
  return samples / TEST_SAMPLE_RATE;
}

function makeParameters(loopStartSamples: number, loopEndSamples: number, trimEnd = 1): Parameters {
  return {
    masterGain: new Float32Array([1]),
    pan: new Float32Array([0]),
    playbackRate: new Float32Array([1]),
    detune: new Float32Array([0]),
    loopStart: new Float32Array([samplesToSeconds(loopStartSamples)]),
    loopEnd: new Float32Array([samplesToSeconds(loopEndSamples)]),
    trimStart: new Float32Array([0]),
    trimEnd: new Float32Array([trimEnd]),
    loopDurationDriftAmount: new Float32Array([0]),
  };
}

async function startProcessor(playbackDirection: 'forward' | 'reverse') {
  const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
  const processor = new SamplePlayerProcessor() as unknown as TestProcessor;

  processor.voice.enableLoopCrossfade = false;
  processor.port.onmessage?.({
    data: {
      type: 'voice:setBuffer',
      buffer: [new Float32Array(TEST_SAMPLE_RATE)],
      durationSeconds: 1,
    },
  } as MessageEvent);
  processor.port.onmessage?.({
    data: { type: 'voice:setLoopEnabled', value: true },
  } as MessageEvent);
  if (playbackDirection === 'reverse') {
    processor.port.onmessage?.({
      data: { type: 'voice:setPlaybackDirection', playbackDirection },
    } as MessageEvent);
  }
  processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);

  return processor;
}

function render(processor: TestProcessor, parameters: Parameters, frames: number) {
  for (let frame = 0; frame < frames; frame++) {
    processor.process([], [[new Float32Array(1)]], parameters);
  }
}

// A loop point can move behind the playhead mid-pass. The pass plays out to the latched
// window's edge, and the wrap lands inside the new loop, however far it moved.
describe('loop points moving behind the playhead', () => {
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

  it('wraps into the narrowed loop when loopEnd moves behind the playhead', async () => {
    const processor = await startProcessor('forward');

    const wide = makeParameters(0, WIDE_LOOP_SAMPLES);
    render(processor, wide, WIDE_LOOP_SAMPLES - 99);
    expect(processor.voice.playheadPosition).toBeGreaterThan(NARROW_LOOP_SAMPLES);

    const narrow = makeParameters(0, NARROW_LOOP_SAMPLES);
    render(processor, narrow, 1);
    expect(processor.voice.playheadPosition).toBeGreaterThan(NARROW_LOOP_SAMPLES);

    render(processor, narrow, 100);
    expect(processor.voice.playheadPosition).toBeGreaterThanOrEqual(0);
    expect(processor.voice.playheadPosition).toBeLessThan(NARROW_LOOP_SAMPLES);
  });

  it('wraps into the narrowed loop when loopStart moves past the playhead in reverse', async () => {
    const processor = await startProcessor('reverse');

    // End trim at the loop end so reverse starts inside the loop
    // rather than descending the whole buffer to reach it.
    const trimEnd = WIDE_LOOP_SAMPLES / TEST_SAMPLE_RATE;
    const wide = makeParameters(0, WIDE_LOOP_SAMPLES, trimEnd);
    render(processor, wide, WIDE_LOOP_SAMPLES - 100);
    expect(processor.voice.playheadPosition).toBeLessThan(WIDE_LOOP_SAMPLES - NARROW_LOOP_SAMPLES);

    // loopStart jumps forward past the playhead, leaving a 100-sample loop at the top.
    const narrow = makeParameters(
      WIDE_LOOP_SAMPLES - NARROW_LOOP_SAMPLES,
      WIDE_LOOP_SAMPLES,
      trimEnd,
    );
    render(processor, narrow, 101);
    expect(processor.voice.playheadPosition).toBeGreaterThanOrEqual(
      WIDE_LOOP_SAMPLES - NARROW_LOOP_SAMPLES,
    );
    expect(processor.voice.playheadPosition).toBeLessThan(WIDE_LOOP_SAMPLES);
  });
});
