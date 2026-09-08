import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const TEST_SAMPLE_RATE = 48_000;
const BLOCK_SIZE = 128;

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
  driftUpdateCounter: number;
  nextDriftGenerated: boolean;
  pendingStartFrame: number;
  playbackPosition: number;
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

type Parameters = Record<string, Float32Array>;

function makeParameters(driftAmount = 0): Parameters {
  return {
    masterGain: new Float32Array([1]),
    envGain: new Float32Array([1]),
    velocity: new Float32Array([127]),
    pan: new Float32Array([0]),
    playbackRate: new Float32Array([1]),
    loopStart: new Float32Array([0]),
    loopEnd: new Float32Array([0.5]),
    startPoint: new Float32Array([0]),
    endPoint: new Float32Array([1]),
    playbackPosition: new Float32Array([0]),
    loopDurationDriftAmount: new Float32Array([driftAmount]),
    maxLoopCount: new Float32Array([999_999]),
    tempo: new Float32Array([120]),
  };
}

async function createProcessor(startFrame: number) {
  const { SamplePlayerProcessor } = await import("../sample-player-processor.js");
  const processor = new SamplePlayerProcessor() as unknown as TestProcessor;
  const channel = new Float32Array(TEST_SAMPLE_RATE).fill(0.5);

  processor.port.onmessage?.({
    data: {
      type: "voice:setBuffer",
      buffer: [channel],
      durationSeconds: 1,
    },
  } as MessageEvent);
  processor.port.onmessage?.({ data: { type: "setLoopEnabled", value: true } } as MessageEvent);
  processor.port.onmessage?.({
    data: { type: "voice:start", timestamp: startFrame / TEST_SAMPLE_RATE },
  } as MessageEvent);

  return processor;
}

function setCurrentFrame(frame: number) {
  vi.stubGlobal("currentFrame", frame);
}

describe("scheduled sample start", () => {
  beforeAll(() => {
    vi.stubGlobal("AudioWorkletProcessor", MockAudioWorkletProcessor);
    vi.stubGlobal("sampleRate", TEST_SAMPLE_RATE);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("currentFrame", 0);
    vi.stubGlobal("registerProcessor", vi.fn());
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCurrentFrame(0);
  });

  it("leaves playback and loop-drift state untouched before the start block", async () => {
    const random = vi.spyOn(Math, "random");
    const processor = await createProcessor(BLOCK_SIZE * 2);
    const output = new Float32Array(BLOCK_SIZE);

    processor.process([], [[output]], makeParameters(0.2));

    expect(output.every((sample) => sample === 0)).toBe(true);
    expect(processor.playbackPosition).toBe(0);
    expect(processor.driftUpdateCounter).toBe(0);
    expect(processor.nextDriftGenerated).toBe(false);
    expect(random).not.toHaveBeenCalled();
  });

  it("starts at the scheduled sample within a render block", async () => {
    const startOffset = 64;
    const processor = await createProcessor(startOffset);
    const output = new Float32Array(BLOCK_SIZE);

    processor.process([], [[output]], makeParameters());

    expect(Array.from(output.slice(0, startOffset))).toEqual(
      Array.from(new Float32Array(startOffset)),
    );
    expect(output[startOffset]).toBeGreaterThan(0);
    expect(output[BLOCK_SIZE - 1]).toBeGreaterThan(0);
    expect(processor.playbackPosition).toBe(BLOCK_SIZE - startOffset);
    expect(processor.pendingStartFrame).toBe(0);
  });

  it("starts immediately when the scheduled frame has already passed", async () => {
    const processor = await createProcessor(32);
    const output = new Float32Array(BLOCK_SIZE);
    setCurrentFrame(64);

    processor.process([], [[output]], makeParameters());

    expect(output[0]).toBeGreaterThan(0);
    expect(processor.playbackPosition).toBe(BLOCK_SIZE);
    expect(processor.pendingStartFrame).toBe(0);
  });

  it.each(["voice:reset", "voice:stop"])("clears a pending start on %s", async (type) => {
    const processor = await createProcessor(BLOCK_SIZE * 2);

    processor.port.onmessage?.({ data: { type } } as MessageEvent);

    expect(processor.pendingStartFrame).toBe(0);
  });
});
