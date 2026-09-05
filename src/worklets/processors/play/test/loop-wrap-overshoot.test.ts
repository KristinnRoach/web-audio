import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const TEST_SAMPLE_RATE = 48_000;
// Both loop lengths stay under PITCH_PRESERVATION_THRESHOLD (floor(48000 * 0.061) = 2928)
// so no zero-crossing snapping runs against the silent test buffer.
const WIDE_LOOP_SAMPLES = 2000;
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
  enableLoopSmoothing: boolean;
  loopCount: number;
  playbackPosition: number;
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

type Parameters = Record<string, Float32Array>;

function samplesToSeconds(samples: number) {
  // Match the source frame the processor lands on after Float32 conversion and floor.
  return (samples + 0.25) / TEST_SAMPLE_RATE;
}

function makeParameters(
  loopStartSamples: number,
  loopEndSamples: number,
  endPoint = 1,
): Parameters {
  return {
    masterGain: new Float32Array([1]),
    envGain: new Float32Array([1]),
    velocity: new Float32Array([127]),
    pan: new Float32Array([0]),
    playbackRate: new Float32Array([1]),
    loopStart: new Float32Array([samplesToSeconds(loopStartSamples)]),
    loopEnd: new Float32Array([samplesToSeconds(loopEndSamples)]),
    startPoint: new Float32Array([0]),
    endPoint: new Float32Array([endPoint]),
    playbackPosition: new Float32Array([0]),
    loopDurationDriftAmount: new Float32Array([0]),
    maxLoopCount: new Float32Array([999_999]),
    tempo: new Float32Array([120]),
  };
}

async function startProcessor(playbackDirection: "forward" | "reverse") {
  const { SamplePlayerProcessor } = await import("../sample-player-processor.js");
  const processor = new SamplePlayerProcessor() as unknown as TestProcessor;

  processor.enableLoopSmoothing = false;
  processor.port.onmessage?.({
    data: {
      type: "voice:setBuffer",
      buffer: [new Float32Array(TEST_SAMPLE_RATE)],
      durationSeconds: 1,
    },
  } as MessageEvent);
  processor.port.onmessage?.({ data: { type: "setLoopEnabled", value: true } } as MessageEvent);
  if (playbackDirection === "reverse") {
    processor.port.onmessage?.({
      data: { type: "voice:setPlaybackDirection", playbackDirection },
    } as MessageEvent);
  }
  processor.port.onmessage?.({ data: { type: "voice:start" } } as MessageEvent);

  return processor;
}

function render(processor: TestProcessor, parameters: Parameters, frames: number) {
  for (let frame = 0; frame < frames; frame++) {
    processor.process([], [[new Float32Array(1)]], parameters);
  }
}

// loopRange is recomputed once per block, so a loop point can move behind the playhead
// between blocks. The wrap carries the fractional overshoot to keep the loop period
// exact; when the overshoot exceeds the whole loop it has to fall back to a plain snap
// or the playhead lands outside the loop entirely.
describe("loop wrap with an overshoot larger than the loop", () => {
  beforeAll(() => {
    vi.stubGlobal("AudioWorkletProcessor", MockAudioWorkletProcessor);
    vi.stubGlobal("sampleRate", TEST_SAMPLE_RATE);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("registerProcessor", vi.fn());
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the playhead inside the loop when loopEnd moves behind it", async () => {
    const processor = await startProcessor("forward");

    const wide = makeParameters(0, WIDE_LOOP_SAMPLES);
    render(processor, wide, WIDE_LOOP_SAMPLES - 100);
    expect(processor.playbackPosition).toBeGreaterThan(NARROW_LOOP_SAMPLES);

    // loopEnd jumps back behind the playhead: overshoot is ~18x the new loop length.
    const narrow = makeParameters(0, NARROW_LOOP_SAMPLES);
    render(processor, narrow, 1);

    expect(processor.playbackPosition).toBeLessThanOrEqual(NARROW_LOOP_SAMPLES);
    expect(processor.playbackPosition).toBeGreaterThanOrEqual(0);
  });

  it("keeps the playhead inside the loop when loopStart moves past it in reverse", async () => {
    const processor = await startProcessor("reverse");

    // End the playback range at the loop end so reverse starts inside the loop
    // rather than descending the whole buffer to reach it.
    const endPoint = WIDE_LOOP_SAMPLES / TEST_SAMPLE_RATE;
    const wide = makeParameters(0, WIDE_LOOP_SAMPLES, endPoint);
    render(processor, wide, WIDE_LOOP_SAMPLES - 100);
    expect(processor.playbackPosition).toBeLessThan(WIDE_LOOP_SAMPLES - NARROW_LOOP_SAMPLES);

    // loopStart jumps forward past the playhead, leaving a 100-sample loop at the top.
    const narrow = makeParameters(
      WIDE_LOOP_SAMPLES - NARROW_LOOP_SAMPLES,
      WIDE_LOOP_SAMPLES,
      endPoint,
    );
    render(processor, narrow, 1);

    expect(processor.playbackPosition).toBeGreaterThanOrEqual(
      WIDE_LOOP_SAMPLES - NARROW_LOOP_SAMPLES,
    );
    expect(processor.playbackPosition).toBeLessThanOrEqual(WIDE_LOOP_SAMPLES);
  });
});
