// createEnvelope.ts
import { CustomEnvelope } from "./CustomEnvelope";
import type { EnvelopePoint, EnvelopeState, EnvelopeType } from "./env-types";
import type { EnvelopeData } from "./EnvelopeData";

interface EnvelopeOptions {
  durationSeconds?: number;
  points?: EnvelopePoint[];
  envPointValueRange?: [number, number];
  initEnable?: boolean;
  sharedData?: EnvelopeData;
  sustainPointIndex?: number | null;
  releasePointIndex?: number;
}

/** Default serializable state with point times scaled to the requested duration. */
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

export function createEnvelope(
  context: AudioContext,
  type: EnvelopeType,
  options: EnvelopeOptions = {},
): CustomEnvelope {
  const {
    durationSeconds = 2,
    points,
    sustainPointIndex,
    releasePointIndex,
    envPointValueRange,
    initEnable,
    sharedData,
  } = options;

  // Use shared data if provided // todo: finish or remove
  if (sharedData) {
    return new CustomEnvelope(context, type, sharedData);
  }

  const defaults = defaultEnvelopeState(type, durationSeconds);

  // Use custom values or defaults
  const finalPoints = points || defaults.shape.points;
  const finalValueRange = envPointValueRange || defaults.shape.valueRange;
  const finalInitEnable = initEnable !== undefined ? initEnable : defaults.enabled;
  const finalSustainIndex =
    sustainPointIndex !== undefined ? sustainPointIndex : defaults.shape.sustainIndex;
  const finalReleaseIndex =
    releasePointIndex !== undefined ? releasePointIndex : defaults.shape.releaseIndex;

  const envelope = new CustomEnvelope(
    context,
    type,
    undefined, // no shared data
    finalPoints,
    finalValueRange,
    durationSeconds,
    finalInitEnable,
  ); // Set sustain and release points
  envelope.setSustainPoint(finalSustainIndex);
  if (finalReleaseIndex) envelope.setReleasePoint(finalReleaseIndex);

  return envelope;
}
