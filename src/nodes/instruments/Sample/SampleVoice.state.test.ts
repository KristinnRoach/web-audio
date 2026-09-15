import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SampleVoice } from "./SampleVoice";
import { VoiceState } from "../VoiceState";

const SAMPLE_RATE = 48000;

/**
 * Web Audio stubs, installed before SampleVoice is imported because modules in
 * its import graph subclass AudioWorkletNode at load time.
 */
const audio = vi.hoisted(() => {
  const PARAM_NAMES = ["envGain", "playbackRate", "velocity", "loopStart", "loopEnd"];

  const noop = () => {};
  const fakeParam = () =>
    ({
      value: 1,
      linearRampToValueAtTime: noop,
      cancelScheduledValues: noop,
      cancelAndHoldAtTime: noop,
      setValueAtTime: noop,
      exponentialRampToValueAtTime: noop,
      setTargetAtTime: noop,
      setValueCurveAtTime: noop,
    }) as unknown as AudioParam;

  /** The single worklet port of the most recently constructed voice. */
  const latest = {
    port: null as unknown as { postMessage: (m: any) => void; onmessage: (e: any) => void },
    posted: [] as any[],
  };

  class FakeAudioWorkletNode {
    parameters = new Map(PARAM_NAMES.map((name) => [name, fakeParam()]));
    port = {
      postMessage: (msg: any) => latest.posted.push(msg),
      start: () => {},
      onmessage: null,
    };
    constructor() {
      latest.port = this.port as any;
    }
    connect() {}
    disconnect() {}
  }

  class FakeGainNode {
    gain = fakeParam();
    connect() {}
    disconnect() {}
  }

  Object.assign(globalThis, { AudioWorkletNode: FakeAudioWorkletNode, GainNode: FakeGainNode });
  return latest;
});

const fakeBuffer = () =>
  ({
    sampleRate: SAMPLE_RATE,
    duration: 1,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(8),
  }) as unknown as AudioBuffer;

/** A voice with no internal chain - filters, AM and feedback are not state. */
function newVoice() {
  audio.posted = [];
  const context = { currentTime: 0, sampleRate: SAMPLE_RATE } as unknown as AudioContext;
  return new SampleVoice(context, { internalSignalChain: [] });
}

async function loadedVoice() {
  const voice = newVoice();
  await voice.init();
  await voice.loadLayers([fakeBuffer()]);
  audio.posted = [];
  return voice;
}

const trigger = (voice: SampleVoice, midiNote = 60) => voice.trigger({ midiNote, velocity: 100 });
const sentTypes = () => audio.posted.map((m) => m.type);
const stopEcho = () => audio.port.onmessage({ data: { type: "voice:stopped" } });

describe("SampleVoice state", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is AVAILABLE until triggered", async () => {
    const voice = await loadedVoice();
    expect(voice.state).toBe(VoiceState.AVAILABLE);

    expect(trigger(voice)).toBe(60);
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.currMidiNote).toBe(60);
  });

  it("refuses to trigger before audio is loaded", async () => {
    const voice = newVoice();
    await voice.init();

    expect(trigger(voice)).toBeNull();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes()).not.toContain("voice:start");
  });

  it("stops rather than restarts when triggered while sounding", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    expect(trigger(voice, 64)).toBeNull();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it("releases only from PLAYING", async () => {
    const voice = await loadedVoice();

    voice.release({ releaseTime: 1 });
    expect(voice.state).toBe(VoiceState.AVAILABLE);

    trigger(voice);
    voice.release({ releaseTime: 1 });
    expect(voice.state).toBe(VoiceState.RELEASING);

    voice.release({ releaseTime: 1 });
    expect(voice.state).toBe(VoiceState.RELEASING);
  });

  it("treats a zero release as a stop, including mid-tail", async () => {
    const voice = await loadedVoice();
    trigger(voice);
    voice.release({ releaseTime: 1 });

    voice.release({ releaseTime: 0 });
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it("stops itself when the release tail runs out", async () => {
    const voice = await loadedVoice();
    trigger(voice);
    voice.release({ releaseTime: 0.1 });

    vi.runAllTimers();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it("does not stop a voice that is already stopped", async () => {
    const voice = await loadedVoice();
    trigger(voice);
    voice.stop();
    vi.runAllTimers();
    expect(sentTypes().filter((t) => t === "voice:stop")).toHaveLength(1);

    voice.stop();
    vi.runAllTimers();

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes().filter((t) => t === "voice:stop")).toHaveLength(1);
  });

  it("reports AVAILABLE before the processor does", async () => {
    const voice = await loadedVoice();
    trigger(voice);

    voice.stop();

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes()).not.toContain("voice:stop");

    vi.runAllTimers();
    expect(audio.posted.at(-1)).toEqual({ type: "voice:stop", timestamp: 0 });
  });

  it("holds a stop scheduled for a future timestamp", async () => {
    const voice = await loadedVoice();
    trigger(voice);

    voice.stop(0.5); // context currentTime is 0 in this suite

    expect(sentTypes()).not.toContain("voice:stop");
    vi.advanceTimersByTime(499);
    expect(sentTypes()).not.toContain("voice:stop");

    vi.advanceTimersByTime(2);
    expect(audio.posted.at(-1)).toEqual({ type: "voice:stop", timestamp: 0.5 });
  });

  it("disarms a pending stop when retriggered before it is posted", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);
    voice.stop();

    trigger(voice, 64);
    vi.runAllTimers();

    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.currMidiNote).toBe(64);
    expect(sentTypes()).not.toContain("voice:stop");
  });

  it("ignores a stop echo that lags a retrigger", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);
    voice.stop();
    trigger(voice, 64);

    stopEcho(); // echo of note 60's stop, arriving after note 64 started

    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.currMidiNote).toBe(64);
  });

  it("clears the active note on a stop echo it is waiting for", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);
    voice.stop();

    stopEcho();

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.currMidiNote).toBeNull();
    expect(voice.isActive).toBe(false);
  });

  it("ends the note when new layers are loaded under it", async () => {
    const voice = await loadedVoice();
    trigger(voice);

    await voice.loadLayers([fakeBuffer()]);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });
});
