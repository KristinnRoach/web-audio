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
const endPlayback = (triggerId = 1) =>
  audio.port.onmessage({ data: { type: "voice:ended", triggerId } });

describe("SampleVoice state", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refuses to trigger before audio is loaded", async () => {
    const voice = newVoice();
    await voice.init();

    expect(trigger(voice)).toBeNull();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes()).not.toContain("voice:start");
  });

  it("owns the complete lifecycle and reports each transition synchronously", async () => {
    const voice = await loadedVoice();
    const events: string[] = [];
    ["voice:started", "voice:releasing", "voice:stopped"].forEach((type) => {
      voice.onMessage(type, () => events.push(type));
    });

    voice.release({ releaseTime: 0.1 });
    expect(voice.state).toBe(VoiceState.AVAILABLE);

    expect(trigger(voice)).toBe(60);
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(60);

    voice.release({ releaseTime: 0.1 });
    voice.release({ releaseTime: 0.1 });
    expect(voice.state).toBe(VoiceState.RELEASING);

    vi.runAllTimers();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.midiNote).toBeNull();
    expect(events).toEqual(["voice:started", "voice:releasing", "voice:stopped"]);
  });

  it("stops rather than retriggering an active voice", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    expect(trigger(voice, 64)).toBeNull();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.midiNote).toBeNull();
  });

  it("treats a zero release as one idempotent stop", async () => {
    const voice = await loadedVoice();
    trigger(voice);
    voice.release({ releaseTime: 0.1 });
    voice.release({ releaseTime: 0 });
    voice.stop();
    vi.runAllTimers();

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes().filter((t) => t === "voice:stop")).toHaveLength(1);
  });

  it("coalesces a synchronous stop and retrigger", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    voice.stop();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes()).not.toContain("voice:stop");

    trigger(voice, 64);
    vi.runAllTimers();
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(64);
    expect(sentTypes()).not.toContain("voice:stop");
  });

  it("ignores completion from an older playback with the same timestamp", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);
    voice.stop();
    trigger(voice, 64);

    const starts = audio.posted.filter((message) => message.type === "voice:start");
    expect(starts.map(({ timestamp }) => timestamp)).toEqual([0, 0]);
    expect(starts.map(({ triggerId }) => triggerId)).toEqual([1, 2]);

    endPlayback(1);
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(64);

    endPlayback(2);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
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

  it("accepts current natural completion and ignores completion from the previous note", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    endPlayback(1);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.midiNote).toBeNull();
    voice.trigger({ midiNote: 64, velocity: 100, secondsFromNow: 1 });

    endPlayback(1);

    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(64);
  });

  it("distinguishes a load acknowledgement from replacing the loaded layers", async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    audio.port.onmessage({ data: { type: "voice:loaded", durationSeconds: 1 } });

    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(60);

    await voice.loadLayers([fakeBuffer()]);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });
});
