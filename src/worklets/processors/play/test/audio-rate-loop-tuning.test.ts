import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { midiToPlaybackRate } from "../../../../utils/music-theory/utils/core-utils";

const TEST_SAMPLE_RATE = 48_000;
const ROOT_MIDI_NOTE = 60;
const LOOP_LENGTH_SAMPLES = 192;
const FIRST_MIDI_NOTE = 36;
const LAST_MIDI_NOTE = 96;
const WRAPS_TO_MEASURE = 32;
const TUNING_TOLERANCE_CENTS = 3;

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
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters): boolean;
};

type Parameters = Record<string, Float32Array>;

function makeParameters(playbackRate: number): Parameters {
  return {
    masterGain: new Float32Array([1]),
    envGain: new Float32Array([1]),
    velocity: new Float32Array([127]),
    pan: new Float32Array([0]),
    playbackRate: new Float32Array([playbackRate]),
    loopStart: new Float32Array([0]),
    loopEnd: new Float32Array([LOOP_LENGTH_SAMPLES / TEST_SAMPLE_RATE]),
    startPoint: new Float32Array([0]),
    endPoint: new Float32Array([1]),
    playbackPosition: new Float32Array([0]),
    loopDurationDriftAmount: new Float32Array([0]),
    maxLoopCount: new Float32Array([999_999]),
    tempo: new Float32Array([120]),
  };
}

async function measureLoopPeriod(midiNote: number): Promise<number> {
  const { SamplePlayerProcessor } = await import("../sample-player-processor.js");
  const processor = new SamplePlayerProcessor() as unknown as TestProcessor;
  const channel = new Float32Array(TEST_SAMPLE_RATE);

  processor.enableLoopSmoothing = false;
  processor.port.onmessage?.({
    data: {
      type: "voice:setBuffer",
      buffer: [channel],
      durationSeconds: 1,
    },
  } as MessageEvent);
  processor.port.onmessage?.({ data: { type: "setLoopEnabled", value: true } } as MessageEvent);
  processor.port.onmessage?.({ data: { type: "voice:start" } } as MessageEvent);

  const parameters = makeParameters(midiToPlaybackRate(midiNote, ROOT_MIDI_NOTE));
  const wrapFrames: number[] = [];
  let previousLoopCount = 0;

  for (let frame = 0; wrapFrames.length < WRAPS_TO_MEASURE; frame++) {
    processor.process([], [[new Float32Array(1)]], parameters);
    if (processor.loopCount !== previousLoopCount) {
      wrapFrames.push(frame);
      previousLoopCount = processor.loopCount;
    }
  }

  return (wrapFrames[wrapFrames.length - 1] - wrapFrames[0]) / (wrapFrames.length - 1);
}

describe("audio-rate loop tuning", () => {
  beforeAll(() => {
    vi.stubGlobal("AudioWorkletProcessor", MockAudioWorkletProcessor);
    vi.stubGlobal("sampleRate", TEST_SAMPLE_RATE);
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("registerProcessor", vi.fn());
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("stays in tune while stepping chromatically from C2 through C7", async () => {
    const results = [];

    for (let midiNote = FIRST_MIDI_NOTE; midiNote <= LAST_MIDI_NOTE; midiNote++) {
      const playbackRate = midiToPlaybackRate(midiNote, ROOT_MIDI_NOTE);
      const expectedPeriod = LOOP_LENGTH_SAMPLES / playbackRate;
      const measuredPeriod = await measureLoopPeriod(midiNote);
      const centsError = 1_200 * Math.log2(expectedPeriod / measuredPeriod);

      results.push({ midiNote, expectedPeriod, measuredPeriod, centsError });
    }

    const outOfTuneNotes = results
      .filter(({ centsError }) => Math.abs(centsError) > TUNING_TOLERANCE_CENTS)
      .map(({ midiNote, centsError }) => ({
        midiNote,
        centsError: Number(centsError.toFixed(2)),
      }));

    expect(outOfTuneNotes, "notes outside the 3-cent tuning tolerance").toEqual([]);
  });
});
