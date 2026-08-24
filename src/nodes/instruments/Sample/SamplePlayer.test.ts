import { describe, expect, it, vi } from "vite-plus/test";
import type { SamplePlayer } from "./SamplePlayer";

describe("SamplePlayer.applyParams", () => {
  it("applies only valid parameter values", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
    const { SamplePlayer } = await import("./SamplePlayer");
    const setVolume = vi.fn();
    const setGlideTime = vi.fn();
    const setTempo = vi.fn();
    const setFeedbackPitchScale = vi.fn();
    const player = {
      setVolume,
      setGlideTime,
      setTempo,
      setFeedbackPitchScale,
    } as unknown as SamplePlayer;

    SamplePlayer.prototype.applyParams.call(player, {
      volume: 0.75,
      glide: 0.2,
      unknown: 1,
      tempo: 301,
      feedbackPitch: 0.3,
    } as never);

    expect(setVolume).toHaveBeenCalledWith(0.75);
    expect(setGlideTime).toHaveBeenCalledWith(0.2);
    expect(setTempo).not.toHaveBeenCalled();
    expect(setFeedbackPitchScale).not.toHaveBeenCalled();
  });
});
