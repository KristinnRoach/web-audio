import { describe, expect, it } from "vite-plus/test";
import { defaultEnvelopeState } from "./createEnvelope";

describe("defaultEnvelopeState", () => {
  it("maps runtime defaults to detached serializable state at the requested duration", () => {
    const state = defaultEnvelopeState("amp-env", 4);

    expect(state).toEqual({
      enabled: true,
      timeScale: 1,
      playbackRateSync: false,
      loop: false,
      shape: {
        kind: "points",
        points: [
          { time: 0, value: 0, curve: "exponential" },
          { time: 0.005, value: 1, curve: "exponential" },
          { time: 1, value: 0.75, curve: "exponential" },
          { time: 3.6, value: 0.5, curve: "exponential" },
          { time: 4, value: 0, curve: "exponential" },
        ],
        valueRange: [0, 1],
        sustainIndex: null,
        releaseIndex: 3,
      },
    });
  });

  it("rejects invalid durations", () => {
    expect(() => defaultEnvelopeState("amp-env", 0)).toThrow(RangeError);
  });
});
