import { describe, expect, it, vi } from "vite-plus/test";
import type { SamplePlayer } from "./SamplePlayer";
import type { EnvelopeSettings } from "../../params/envelopes";

const settings: EnvelopeSettings = {
  enabled: false,
  timeScale: 2,
  envelope: {
    points: [
      { time: 0, value: 0, curve: "linear" },
      { time: 1, value: 1, curve: "exponential" },
    ],
    release: 1,
  },
};

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

describe("SamplePlayer envelope settings", () => {
  it("resets an envelope to defaults at the current sample duration", async () => {
    const { SamplePlayer } = await import("./SamplePlayer");
    const applyEnvelopeSettings = vi.fn();
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      applyEnvelopeSettings,
    }) as SamplePlayer;
    Object.defineProperty(player, "sampleDuration", { value: 4 });

    player.resetEnvelope("pitch-env");

    expect(applyEnvelopeSettings).toHaveBeenCalledWith(
      "pitch-env",
      expect.objectContaining({
        enabled: false,
        envelope: expect.objectContaining({
          points: [
            { time: 0, value: 1, curve: "exponential" },
            { time: 4, value: 1, curve: "exponential" },
          ],
        }),
      }),
    );
  });

  it("applies a detached snapshot to every voice and emits once", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
    const { SamplePlayer } = await import("./SamplePlayer");
    const applyEnvelopeSettings = vi.fn();
    const sendUpstreamMessage = vi.fn();
    const input: EnvelopeSettings = {
      ...settings,
      envelope: {
        ...settings.envelope,
        points: settings.envelope.points.map((point) => ({ ...point })),
      },
    };
    const voices = [{ applyEnvelopeSettings }, { applyEnvelopeSettings }];
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      envelopeSettings: new Map(),
      voicePool: {
        allVoices: voices,
        applyToAllVoices: (fn: (voice: (typeof voices)[number]) => void) => voices.forEach(fn),
      },
      sendUpstreamMessage,
    }) as SamplePlayer;

    player.applyEnvelopeSettings("amp-env", input);
    (input.envelope.points[0] as { value: number }).value = 99;

    expect(applyEnvelopeSettings).toHaveBeenCalledTimes(2);
    expect(player.getEnvelopeSettings("amp-env").envelope.points[0].value).toBe(0);
    expect(sendUpstreamMessage).toHaveBeenCalledOnce();
    expect(sendUpstreamMessage).toHaveBeenCalledWith("envelope:changed", {
      envelopeId: "amp-env",
      settings: expect.objectContaining({ enabled: false }),
    });
  });

  it("rejects invalid snapshots before mutating voices", async () => {
    const { SamplePlayer } = await import("./SamplePlayer");
    const applyToAllVoices = vi.fn();
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      envelopeSettings: new Map(),
      voicePool: {
        allVoices: [],
        applyToAllVoices,
      },
      sendUpstreamMessage: vi.fn(),
    }) as SamplePlayer;

    expect(() =>
      player.applyEnvelopeSettings("amp-env", { ...settings, timeScale: 0 }),
    ).toThrowError("Invalid envelope settings");
    expect(() =>
      player.applyEnvelopeSettings("amp-env", {
        ...settings,
        envelope: { ...settings.envelope, release: 99 },
      }),
    ).toThrowError("Invalid envelope settings");
    expect(applyToAllVoices).not.toHaveBeenCalled();
  });
});
