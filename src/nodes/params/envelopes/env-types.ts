export type EnvelopeType = "amp-env" | "pitch-env" | "filter-env" | "loop-env" | "default-env";

/** Envelope types available on SamplePlayer. */
export type SampleEnvelopeType = Extract<EnvelopeType, "amp-env" | "pitch-env" | "filter-env">;

export type EnvelopePoint = {
  time: number; // Absolute time in seconds
  value: number; // value to be applied to audioparam
  curve?: "linear" | "exponential"; // Curve type to next point
};

/** Point-based envelope shape. Point times are in seconds. */
export type PointEnvelopeShape = {
  kind: "points";
  points: EnvelopePoint[];
  /** Point held until note release, or null for no sustain. */
  sustainIndex: number | null;
  /** Point from which note release continues. */
  releaseIndex: number;
};

/** Serializable SamplePlayer envelope state. */
export type EnvelopeState = {
  enabled: boolean;
  /** Timing multiplier; values above 1 play the envelope faster. */
  timeScale: number;
  /** Whether sample playback rate also scales envelope timing. */
  playbackRateSync: boolean;
  loop: boolean;
  shape: PointEnvelopeShape;
};
