export type EnvelopeType = "amp-env" | "pitch-env" | "filter-env" | "loop-env" | "default-env";

export type SampleEnvelopeType = Extract<EnvelopeType, "amp-env" | "pitch-env" | "filter-env">;

export type EnvelopePoint = {
  time: number; // Absolute time in seconds
  value: number; // value to be applied to audioparam
  curve?: "linear" | "exponential"; // Curve type to next point
};

export type PointEnvelopeShape = {
  kind: "points";
  points: EnvelopePoint[];
  sustainIndex: number | null;
  releaseIndex: number;
};

export type EnvelopeState = {
  enabled: boolean;
  timeScale: number;
  playbackRateSync: boolean;
  loop: boolean;
  shape: PointEnvelopeShape;
};
