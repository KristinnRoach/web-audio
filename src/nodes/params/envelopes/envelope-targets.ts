import {
  envelopePresets,
  type Envelope,
  type EnvelopePoint,
  type EnvelopeSettings,
} from "@/nodes/params/envelopes";

type ResolvedTarget = { envelope: Envelope; amount: number };
type Target = {
  paramName: string;
  defaults: (duration?: number) => EnvelopeSettings;
  resolve: (envelope: Envelope, baseValue: number, param: AudioParam) => ResolvedTarget;
};

const scaled = (envelope: Envelope, baseValue: number): ResolvedTarget => ({
  envelope,
  amount: baseValue,
});

function filter(envelope: Envelope, cutoff: number, param: AudioParam): ResolvedTarget {
  const low = Math.max(cutoff, 1e-3);
  const high = Math.max(param.maxValue, low);
  const logLow = Math.log(low);
  const logRange = Math.log(high) - logLow;
  const points: EnvelopePoint[] = envelope.points.map((point) => ({
    ...point,
    value: Math.exp(logLow + logRange * point.value),
    curve: "exponential",
  }));
  return { envelope: { ...envelope, points }, amount: 1 };
}

export const ENVELOPE_TARGETS = {
  "amp-env": {
    paramName: "envGain",
    defaults: (duration) => envelopePresets.amplitude(duration),
    resolve: scaled,
  },
  "pitch-env": {
    paramName: "playbackRate",
    defaults: (duration) => envelopePresets.pitch(duration),
    resolve: scaled,
  },
  "filter-env": {
    paramName: "lpf",
    defaults: (duration) => envelopePresets.filter(duration),
    resolve: filter,
  },
} as const satisfies Record<string, Target>;

export type EnvelopeId = keyof typeof ENVELOPE_TARGETS;
