import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const TEST_SAMPLE_RATE = 48_000;
const AUDIO_RATE_LOOP_SAMPLES = 192;
const LONG_LOOP_SAMPLES = Math.floor(TEST_SAMPLE_RATE * 0.061) + 64;

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
  applyClickCompensation: boolean;
  loopCount: number;
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

type Parameters = Record<string, Float32Array>;

function makeParameters(loopLengthSamples: number, playbackRate: number): Parameters {
  return {
    masterGain: new Float32Array([1]),
    envGain: new Float32Array([1]),
    velocity: new Float32Array([127]),
    pan: new Float32Array([0]),
    playbackRate: new Float32Array([playbackRate]),
    loopStart: new Float32Array([0]),
    loopEnd: new Float32Array([loopLengthSamples / TEST_SAMPLE_RATE]),
    startPoint: new Float32Array([0]),
    endPoint: new Float32Array([1]),
    playbackPosition: new Float32Array([0]),
    loopDurationDriftAmount: new Float32Array([0]),
    maxLoopCount: new Float32Array([999_999]),
    tempo: new Float32Array([120]),
  };
}

async function renderThroughFirstWrap({
  loopLengthSamples,
  playbackRate,
  playbackDirection = "forward",
}: {
  loopLengthSamples: number;
  playbackRate: number;
  playbackDirection?: "forward" | "reverse";
}): Promise<TestProcessor> {
  const { SamplePlayerProcessor } = await import("../sample-player-processor.js");
  const processor = new SamplePlayerProcessor() as unknown as TestProcessor;
  const channel = new Float32Array(loopLengthSamples);
  channel[0] = -0.25;
  channel[channel.length - 1] = 0.25;

  processor.port.onmessage?.({
    data: {
      type: "voice:setBuffer",
      buffer: [channel],
      durationSeconds: loopLengthSamples / TEST_SAMPLE_RATE,
    },
  } as MessageEvent);
  processor.port.onmessage?.({ data: { type: "setLoopEnabled", value: true } } as MessageEvent);
  if (playbackDirection === "reverse") {
    processor.port.onmessage?.({
      data: { type: "voice:setPlaybackDirection", playbackDirection },
    } as MessageEvent);
  }
  processor.port.onmessage?.({ data: { type: "voice:start" } } as MessageEvent);

  const framesToFirstWrap =
    playbackDirection === "forward"
      ? Math.ceil(loopLengthSamples / playbackRate) + 1
      : Math.ceil((loopLengthSamples - 1) / playbackRate) + 1;

  processor.process(
    [],
    [[new Float32Array(framesToFirstWrap)]],
    makeParameters(loopLengthSamples, playbackRate),
  );

  expect(processor.loopCount).toBe(1);
  return processor;
}

describe("high-rate audio-loop click compensation", () => {
  beforeAll(() => {
    vi.stubGlobal("AudioWorkletProcessor", MockAudioWorkletProcessor);
    vi.stubGlobal("sampleRate", TEST_SAMPLE_RATE);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("registerProcessor", vi.fn());
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("does not arm compensation for a forward high-rate audio loop", async () => {
    const processor = await renderThroughFirstWrap({
      loopLengthSamples: AUDIO_RATE_LOOP_SAMPLES,
      playbackRate: 2,
    });

    expect(processor.applyClickCompensation).toBe(false);
  });

  it("does not arm compensation for a reverse high-rate audio loop", async () => {
    const processor = await renderThroughFirstWrap({
      loopLengthSamples: AUDIO_RATE_LOOP_SAMPLES,
      playbackRate: 2,
      playbackDirection: "reverse",
    });

    expect(processor.applyClickCompensation).toBe(false);
  });

  it("keeps compensation at unity rate for an audio loop", async () => {
    const processor = await renderThroughFirstWrap({
      loopLengthSamples: AUDIO_RATE_LOOP_SAMPLES,
      playbackRate: 1,
    });

    expect(processor.applyClickCompensation).toBe(true);
  });

  it("keeps compensation for a longer loop above unity rate", async () => {
    const processor = await renderThroughFirstWrap({
      loopLengthSamples: LONG_LOOP_SAMPLES,
      playbackRate: 2,
    });

    expect(processor.applyClickCompensation).toBe(true);
  });
});
