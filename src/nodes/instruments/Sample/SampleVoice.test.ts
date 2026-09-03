import { describe, expect, it, vi } from "vite-plus/test";

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
