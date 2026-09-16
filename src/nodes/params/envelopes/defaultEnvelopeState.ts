import type { EnvelopeState, EnvelopeType } from "./env-types";

export function defaultEnvelopeState(type: EnvelopeType, durationSeconds = 1): EnvelopeState {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("Envelope duration must be greater than zero");
  }

  const common = {
    timeScale: 1,
    playbackRateSync: false,
    loop: false,
  };

  switch (type) {
    case "amp-env":
      return {
        ...common,
        enabled: true,
        shape: {
          kind: "points",
          points: [
            { time: 0, value: 0, curve: "exponential" },
            {
              time: Math.min(0.005, 0.1 * durationSeconds),
              value: 1,
              curve: "exponential",
            },
            { time: 0.25 * durationSeconds, value: 0.75, curve: "exponential" },
            { time: 0.9 * durationSeconds, value: 0.5, curve: "exponential" },
            { time: durationSeconds, value: 0, curve: "exponential" },
          ],
          valueRange: [0, 1],
          sustainIndex: null,
          releaseIndex: 3,
        },
      };

    case "pitch-env":
      return {
        ...common,
        enabled: false,
        shape: {
          kind: "points",
          points: [
            { time: 0, value: 1, curve: "exponential" },
            { time: durationSeconds, value: 1, curve: "exponential" },
          ],
          valueRange: [0.5, 1.5],
          sustainIndex: null,
          releaseIndex: 1,
        },
      };

    case "filter-env":
      return {
        ...common,
        enabled: false,
        shape: {
          kind: "points",
          points: [
            { time: 0, value: 0, curve: "exponential" },
            { time: 0.02 * durationSeconds, value: 1, curve: "exponential" },
            { time: 0.3 * durationSeconds, value: 0.2, curve: "exponential" },
            { time: durationSeconds, value: 0, curve: "exponential" },
          ],
          valueRange: [0, 1],
          sustainIndex: null,
          releaseIndex: 2,
        },
      };
  }
}
