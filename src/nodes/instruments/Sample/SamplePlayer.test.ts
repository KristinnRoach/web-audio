import { describe, expect, it, vi } from "vite-plus/test";
import type { SamplePlayer } from "./SamplePlayer";
import type { EnvelopeState } from "../../params/envelopes";

const state: EnvelopeState = {
  enabled: false,
  timeScale: 2,
  playbackRateSync: true,
  loop: false,
  shape: {
    kind: "points",
    points: [
      { time: 0, value: 0, curve: "linear" },
      { time: 1, value: 1, curve: "exponential" },
    ],
    valueRange: [0, 1],
    sustainIndex: null,
    releaseIndex: 1,
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

describe("SamplePlayer envelope state", () => {
  it("resets an envelope to defaults at the current sample duration", async () => {
    const { SamplePlayer } = await import("./SamplePlayer");
    const applyEnvelopeState = vi.fn();
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      applyEnvelopeState,
    }) as SamplePlayer;
    Object.defineProperty(player, "sampleDuration", { value: 4 });

    player.resetEnvelope("pitch-env");

    expect(applyEnvelopeState).toHaveBeenCalledWith(
      "pitch-env",
      expect.objectContaining({
        enabled: false,
        shape: expect.objectContaining({
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
    const applyEnvelopeState = vi.fn();
    const sendUpstreamMessage = vi.fn();
    const input: EnvelopeState = {
      ...state,
      shape: {
        ...state.shape,
        points: state.shape.points.map((point) => ({ ...point })),
        valueRange: [...state.shape.valueRange],
      },
    };
    const envelope = { getState: () => state };
    const voices = [
      { getEnvelope: () => envelope, applyEnvelopeState },
      { getEnvelope: () => envelope, applyEnvelopeState },
    ];
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      envelopeStates: new Map(),
      voicePool: {
        allVoices: voices,
        applyToAllVoices: (fn: (voice: (typeof voices)[number]) => void) => voices.forEach(fn),
      },
      sendUpstreamMessage,
    }) as SamplePlayer;

    player.applyEnvelopeState("amp-env", input);
    input.shape.points[0].value = 99;
    input.shape.valueRange[0] = 99;

    expect(applyEnvelopeState).toHaveBeenCalledTimes(2);
    expect(player.getEnvelopeState("amp-env").shape.points[0].value).toBe(0);
    expect(player.getEnvelopeState("amp-env").shape.valueRange).toEqual([0, 1]);
    expect(sendUpstreamMessage).toHaveBeenCalledOnce();
    expect(sendUpstreamMessage).toHaveBeenCalledWith("envelope:changed", {
      envelopeType: "amp-env",
      state: expect.objectContaining({ enabled: false }),
    });
  });

  it("rejects invalid snapshots before mutating voices", async () => {
    const { SamplePlayer } = await import("./SamplePlayer");
    const applyToAllVoices = vi.fn();
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      envelopeStates: new Map(),
      voicePool: {
        allVoices: [{ getEnvelope: () => ({ getState: () => state }) }],
        applyToAllVoices,
      },
      sendUpstreamMessage: vi.fn(),
    }) as SamplePlayer;

    expect(() => player.applyEnvelopeState("amp-env", { ...state, timeScale: 0 })).toThrowError(
      "Invalid envelope state",
    );
    expect(() =>
      player.applyEnvelopeState("amp-env", {
        ...state,
        shape: { ...state.shape, valueRange: [1, 0] },
      }),
    ).toThrowError("Invalid envelope state");
    expect(applyToAllVoices).not.toHaveBeenCalled();
  });
});
