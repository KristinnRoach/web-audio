import { describe, expect, it, vi } from "vite-plus/test";
import type { SampleVoice } from "./SampleVoice";
import type { SamplePlayer } from "./SamplePlayer";

vi.mock("./createSampleVoice", () => ({
  createSampleVoices: async (numVoices: number) =>
    Array.from({ length: numVoices }, () => ({ onMessage: () => () => {} })),
}));

describe("SampleVoicePool.init", () => {
  // Pins the invariant SamplePlayer.setPitchEnabled / setPlaybackDirection rely on:
  // the full fixed pool exists once init() resolves, so fan-out at call time reaches
  // every voice. If polyphony ever becomes lazy or resizable, those setters must
  // re-apply their state to voices created later.
  it("allocates the whole pool before resolving", async () => {
    const { SampleVoicePool } = await import("./SampleVoicePool");
    const pool = new SampleVoicePool({} as AudioContext, 16);

    await pool.init();

    expect(pool.allVoices).toHaveLength(16);
  });
});

describe("SamplePlayer.setPitchEnabled", () => {
  it("fans out to every voice", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
    const { SamplePlayer } = await import("./SamplePlayer");

    const voices = [0, 1, 2].map(() => ({
      enablePitch: vi.fn(),
      disablePitch: vi.fn(),
    }));
    const player = {
      voicePool: { allVoices: voices as unknown as SampleVoice[] },
    } as unknown as SamplePlayer;

    SamplePlayer.prototype.setPitchEnabled.call(player, true);
    voices.forEach((v) => expect(v.enablePitch).toHaveBeenCalledTimes(1));

    SamplePlayer.prototype.setPitchEnabled.call(player, false);
    voices.forEach((v) => expect(v.disablePitch).toHaveBeenCalledTimes(1));
  });
});
