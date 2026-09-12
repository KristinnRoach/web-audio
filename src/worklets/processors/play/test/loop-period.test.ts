import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const SR = 48_000;

class MockAudioWorkletProcessor {
  readonly port = { onmessage: null as null | ((e: MessageEvent) => void), postMessage: vi.fn() };
}

type Parameters = Record<string, Float32Array>;
type TestProcessor = {
  playbackPosition: number;
  port: { onmessage: ((event: MessageEvent) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

function makeParameters(overrides: Record<string, number>): Parameters {
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
  ) as Parameters;
}

/** Two seconds of 200 Hz, enough to loop any subrange the cases ask for. */
function makeSample() {
  const data = new Float32Array(2 * SR);
  for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
  return data;
}

// An envelope synced to a sample loop is scheduled at absolute times derived from
// (loopEnd - loopStart) / playbackRate. That only stays in phase if the processor's
// real wrap period is the same number, for any loop points a knob can land on.
describe("loop period", () => {
  beforeAll(() => {
    vi.stubGlobal("AudioWorkletProcessor", MockAudioWorkletProcessor);
    vi.stubGlobal("sampleRate", SR);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("currentFrame", 0);
    vi.stubGlobal("registerProcessor", vi.fn());
  });

  afterAll(() => vi.unstubAllGlobals());

  it.each([
    [0, 0.3, 1],
    [0, 0.3, 1.5],
    [0.137, 0.611, 1],
    [0.137, 0.611, 0.83],
    [0.371, 0.833, 1.27],
  ])("wraps every (%s..%s)/%s seconds", async (loopStart, loopEnd, rate) => {
    const { SamplePlayerProcessor } = await import("../sample-player-processor.js");
    const processor = new SamplePlayerProcessor() as unknown as TestProcessor;

    processor.port.onmessage?.({
      data: { type: "voice:setBuffer", buffer: [makeSample()], durationSeconds: 2 },
    } as MessageEvent);
    processor.port.onmessage?.({ data: { type: "setLoopEnabled", value: true } } as MessageEvent);
    processor.port.onmessage?.({ data: { type: "voice:start" } } as MessageEvent);

    const parameters = makeParameters({
      startPoint: loopStart,
      endPoint: loopEnd,
      loopStart,
      loopEnd,
      playbackRate: rate,
    });

    // One frame per call, so a wrap is timed to the sample rather than the quantum.
    const wraps: number[] = [];
    const output = [new Float32Array(1), new Float32Array(1)];
    let previous = processor.playbackPosition;

    for (let frame = 0; frame < SR * 4; frame++) {
      vi.stubGlobal("currentFrame", frame);
      processor.process([], [output], parameters);
      if (processor.playbackPosition < previous && previous > 0) wraps.push(frame / SR);
      previous = processor.playbackPosition;
    }

    const period = (loopEnd - loopStart) / rate;
    expect(wraps.length).toBeGreaterThan(4);

    // Absolute, not pairwise: a period that is a hair short drifts without any
    // single gap looking wrong.
    for (const [index, wrap] of wraps.entries()) {
      expect(Math.abs(wrap - (wraps[0] + index * period))).toBeLessThan(0.001);
    }
  });
});
