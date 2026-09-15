import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { VoiceState } from "../VoiceState";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function makeVoice() {
  vi.stubGlobal("window", {});
  vi.stubGlobal("AudioContext", class {});
  vi.stubGlobal(
    "GainNode",
    class {
      disconnect() {}
    },
  );
  const postMessage = vi.fn();
  const envGain = {
    value: 0.5,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      parameters = new Map([["envGain", envGain]]);
      port = { postMessage, close() {} };
    },
  );
  const { SampleVoice } = await import("./SampleVoice");
  const voice = new SampleVoice({ currentTime: 10, sampleRate: 44100 } as AudioContext, {
    internalSignalChain: [],
  });
  return { voice, envGain, postMessage, load: () => voice.loadLayers([fakeBuffer()]) };
}

/** Enough of an AudioBuffer for loadLayers to accept it. */
function fakeBuffer() {
  return {
    sampleRate: 44100,
    duration: 1,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(4),
  } as unknown as AudioBuffer;
}

describe("SampleVoice immediate release", () => {
  it("stops an already releasing voice after the de-click ramp", async () => {
    vi.useFakeTimers();
    const { voice, envGain, postMessage, load } = await makeVoice();
    await load();

    voice.trigger({ midiNote: 60, velocity: 100 });
    voice.release({ releaseTime: 1 });
    expect(voice.state).toBe(VoiceState.RELEASING);
    voice.release({ releaseTime: 0 });

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(envGain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.005);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice:stop" }));
    vi.advanceTimersByTime(6);
    expect(postMessage).toHaveBeenCalledWith({ type: "voice:stop", timestamp: 10 });
    voice.dispose();
  });
});

describe("SampleVoice state transitions", () => {
  it("refuses to trigger a voice with no audio loaded", async () => {
    const { voice, load } = await makeVoice();

    expect(voice.trigger({ midiNote: 60, velocity: 100 })).toBe(null);
    expect(voice.state).toBe(VoiceState.AVAILABLE);

    await load();
    expect(voice.trigger({ midiNote: 60, velocity: 100 })).toBe(60);
    voice.dispose();
  });

  it("ends a sounding note when its layers are replaced", async () => {
    const { voice, load } = await makeVoice();
    await load();
    voice.trigger({ midiNote: 60, velocity: 100 });

    await load();

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    voice.dispose();
  });

  it("ignores release on a voice that is not playing", async () => {
    const { voice } = await makeVoice();

    voice.release({ releaseTime: 1 });

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    voice.dispose();
  });

  it("does not let a stop scheduled for the previous note cut a retrigger", async () => {
    vi.useFakeTimers();
    const { voice, postMessage, load } = await makeVoice();
    await load();
    postMessage.mockClear();

    voice.trigger({ midiNote: 60, velocity: 100 });
    voice.stop(); // arms the de-click stop for note 60
    voice.trigger({ midiNote: 64, velocity: 100 });

    vi.advanceTimersByTime(100);

    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice:stop" }));
    voice.dispose();
  });
});

describe("SampleVoice signal chain", () => {
  it("rejects duplicate nodes", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
    const { SampleVoice } = await import("./SampleVoice");

    expect(
      () =>
        new SampleVoice({} as AudioContext, {
          internalSignalChain: ["lpf", "lpf"],
        }),
    ).toThrow("SampleVoice signal chain cannot contain duplicate nodes");
  });
});
