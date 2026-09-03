import { describe, it, expect } from "vite-plus/test";
import { detectSinglePitchAC } from "../";

const SAMPLE_RATE = 48000;
const DURATION = 0.5;

function createMockAudioBuffer(data: Float32Array, sampleRate = SAMPLE_RATE): AudioBuffer {
  return {
    sampleRate,
    length: data.length,
    numberOfChannels: 1,
    duration: data.length / sampleRate,
    getChannelData: (channel: number) => {
      if (channel !== 0) throw new Error("Only channel 0 supported in mock");
      return data;
    },
  } as AudioBuffer;
}

function render(fn: (t: number) => number, duration = DURATION): AudioBuffer {
  const samples = Math.floor(duration * SAMPLE_RATE);
  const data = new Float32Array(samples);
  for (let i = 0; i < samples; i++) data[i] = fn(i / SAMPLE_RATE);
  return createMockAudioBuffer(data);
}

const sine =
  (freq: number, amp = 1) =>
  (t: number) =>
    amp * Math.sin(2 * Math.PI * freq * t);
const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Semitone distance, ignoring octaves - transposition wraps, so an octave error is harmless */
function semitoneErrorIgnoringOctaves(detectedHz: number, expectedHz: number): number {
  const semitones = 12 * Math.log2(detectedHz / expectedHz);
  const wrapped = ((semitones % 12) + 12) % 12;
  return Math.min(wrapped, 12 - wrapped);
}

describe("detectSinglePitchAC - prominent pitch in a mixture", () => {
  // Autocorrelation peaks at the common period of a mixture, which is longer than
  // either note. Before sub-harmonic correction these resolved to 55Hz / 82Hz at
  // confidence >0.99 - the right-sounding answer only when the common period
  // happened to be an exact octave below the dominant note.
  const mixtures: Array<[string, number, number, number]> = [
    ["A3 over C#4", 220, 277.18, -12],
    ["C#4 over A3", 277.18, 220, -12],
    ["E4 over B3", 329.63, 246.94, -12],
    ["B3 over E4", 246.94, 329.63, -12],
    ["B3 over E4 (quieter second note)", 246.94, 329.63, -20],
    ["C4 over G4", 261.63, 392, -12],
  ];

  for (const [name, dominantHz, otherHz, db] of mixtures) {
    it(`detects the louder note: ${name}`, async () => {
      const buffer = render((t) => sine(dominantHz)(t) + sine(otherHz, dbToGain(db))(t));

      const result = await detectSinglePitchAC(buffer);

      // Within a third of a semitone: the interfering tone still pulls the
      // estimate by up to ~25 cents, but the note itself is correct
      expect(semitoneErrorIgnoringOctaves(result.frequency, dominantHz)).toBeLessThan(0.35);
    });
  }

  it("detects the sustained note over a short blip of another", async () => {
    const sustainedHz = 277.18;
    const blipHz = 220;
    const buffer = render((t) => sine(sustainedHz)(t) + (t < 0.06 ? sine(blipHz)(t) : 0));

    const result = await detectSinglePitchAC(buffer);

    expect(semitoneErrorIgnoringOctaves(result.frequency, sustainedHz)).toBeLessThan(0.35);
  });
});

describe("detectSinglePitchAC - single notes stay accurate", () => {
  // Sub-harmonic correction must not pull a correct estimate up an octave
  for (const freq of [98, 146.83, 220, 329.63, 523.25]) {
    it(`detects a decaying harmonic tone at ${freq}Hz`, async () => {
      const harmonics = [1, 2, 3, 4, 5, 6];
      const buffer = render(
        (t) =>
          Math.exp(-t / 0.25) *
          harmonics.reduce((sum, h) => sum + Math.sin(2 * Math.PI * freq * h * t) / h, 0),
      );

      const result = await detectSinglePitchAC(buffer);

      expect(semitoneErrorIgnoringOctaves(result.frequency, freq)).toBeLessThan(0.15);
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  }

  for (const freq of [110, 220, 440]) {
    it(`detects a pure sine at ${freq}Hz`, async () => {
      const result = await detectSinglePitchAC(render(sine(freq)));

      expect(semitoneErrorIgnoringOctaves(result.frequency, freq)).toBeLessThan(0.15);
    });
  }
});
