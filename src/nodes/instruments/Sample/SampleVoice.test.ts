import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { VoiceState } from "../VoiceState";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SampleVoice immediate release", () => {
  it("stops an already releasing voice after the de-click ramp", async () => {
    vi.useFakeTimers();
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
    const voice = new SampleVoice({ currentTime: 10 } as AudioContext, {
      internalSignalChain: [],
    });

    voice.release({ releaseTime: 1 });
    expect(voice.state).toBe(VoiceState.RELEASING);
    voice.release({ releaseTime: 0 });

    expect(voice.state).toBe(VoiceState.STOPPING);
    expect(envGain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.005);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice:stop" }));
    vi.advanceTimersByTime(6);
    expect(postMessage).toHaveBeenCalledWith({ type: "voice:stop", timestamp: 10 });
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
