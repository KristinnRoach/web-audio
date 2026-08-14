// Parameter descriptors for SamplePlayer.
// UI-agnostic metadata (range, default, taper, formatting) plus an apply()
// mapping a normalized-or-natural knob value onto the player. Lets any
// frontend render controls without hardcoding per-param knowledge.
import type { SamplePlayer } from './SamplePlayer';

export interface SamplerParamDescriptor {
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  /** UI taper hint: 1 = linear, >1 = more resolution at the low end */
  curve?: number;
  /** Snap increment for UI controls */
  step?: number;
  /** Discrete values only (e.g. pitch scale ratios) */
  allowedValues?: readonly number[];
  format?: (value: number, sampleDurationSeconds: number) => string;
  apply: (player: SamplePlayer, value: number) => void;
}

export function isValidSamplerParamValue(
  descriptor: SamplerParamDescriptor,
  value: unknown,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= descriptor.min &&
    value <= descriptor.max &&
    (!descriptor.allowedValues || descriptor.allowedValues.includes(value))
  );
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const hz = (v: number) => `${v.toFixed(0)} Hz`;
/** Normalized position -> seconds readout */
const seconds = (v: number, duration: number) => `${(v * duration).toFixed(2)} s`;

function defineSamplerParams<K extends string>(
  definitions: Record<K, SamplerParamDescriptor>,
): Record<K, SamplerParamDescriptor> {
  return definitions;
}

export const samplerParams = defineSamplerParams({
  volume: {
    label: 'Volume',
    min: 0,
    max: 1,
    defaultValue: 0.75,
    apply: (p, v) => p.setVolume(v),
  },
  dryWet: {
    label: 'Dry/Wet',
    min: 0,
    max: 1,
    defaultValue: 0.5,
    apply: (p, v) => p.setDryWetMix({ dry: 1 - v, wet: v }),
  },
  glide: {
    label: 'Glide',
    min: 0,
    max: 1,
    defaultValue: 0,
    step: 0.001,
    format: (v) => v.toFixed(3),
    apply: (p, v) => p.setGlideTime(v),
  },
  tempo: {
    label: 'Tempo',
    min: 20,
    max: 300,
    defaultValue: 120,
    step: 1,
    format: (v) => `${v.toFixed(0)} BPM`,
    apply: (p, v) => p.setTempo(v),
  },

  // Filters
  lowpassFilter: {
    label: 'LPF',
    min: 40,
    max: 20000,
    defaultValue: 20000,
    curve: 5,
    format: hz,
    apply: (p, v) => p.setLpfCutoff(v),
  },
  highpassFilter: {
    label: 'HPF',
    min: 20,
    max: 20000,
    defaultValue: 40,
    curve: 5,
    format: hz,
    apply: (p, v) => p.setHpfCutoff(v),
  },

  // Feedback
  feedback: {
    label: 'Feedback',
    min: 0,
    max: 1,
    defaultValue: 0,
    step: 0.001,
    curve: 2.5,
    format: (v) => v.toFixed(3),
    apply: (p, v) => p.setFeedbackAmount(v),
  },
  feedbackPitch: {
    label: 'FB-Pitch',
    min: 0.25,
    max: 4,
    defaultValue: 1,
    allowedValues: [0.25, 0.5, 1, 2, 3, 4],
    curve: 2,
    apply: (p, v) => p.setFeedbackPitchScale(v),
  },
  feedbackDecay: {
    label: 'FB-Decay',
    min: 0.01,
    max: 1,
    defaultValue: 0.75,
    curve: 1.5,
    apply: (p, v) => p.setFeedbackDecay(v),
  },
  feedbackLpf: {
    label: 'FB-LPF',
    min: 400,
    max: 16000,
    defaultValue: 10000,
    curve: 5,
    format: hz,
    apply: (p, v) => p.setFeedbackLowpassCutoff(v),
  },

  // Dirt
  distortion: {
    label: 'Distortion',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 1.5,
    apply: (p, v) => p.outputBus.setDistortionMacro(v),
  },
  drive: {
    label: 'Drive',
    min: 0,
    max: 1,
    defaultValue: 0,
    apply: (p, v) => p.outputBus.setDrive(v),
  },
  clipping: {
    label: 'Clipping',
    min: 0,
    max: 1,
    defaultValue: 0,
    apply: (p, v) => p.outputBus.setClippingMacro(v),
  },
  amMod: {
    label: 'AM',
    min: 0,
    max: 1,
    defaultValue: 0,
    apply: (p, v) => p.setModulationAmount('AM', v),
  },

  // Sends / space
  reverbSend: {
    label: 'Reverb Send',
    min: 0,
    max: 1,
    defaultValue: 0,
    format: pct,
    apply: (p, v) => p.sendToFx('reverb', v),
  },
  reverbSize: {
    label: 'Reverb Size',
    min: 0,
    max: 1,
    defaultValue: 0.7,
    apply: (p, v) => p.setReverbAmount(v),
  },
  delaySend: {
    label: 'Delay Send',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 2,
    format: pct,
    apply: (p, v) => p.sendToFx('delay', v),
  },
  delayTime: {
    label: 'Delay Time',
    min: 0.005,
    max: 1.5,
    defaultValue: 0.1,
    curve: 2,
    format: (v) => `${v.toFixed(3)} s`,
    apply: (p, v) => p.outputBus.setDelayTime(v),
  },
  delayFeedback: {
    label: 'Delay Feedback',
    min: 0,
    max: 1,
    defaultValue: 0.25,
    curve: 1.5,
    format: pct,
    apply: (p, v) => p.outputBus.setDelayFeedback(v),
  },

  // LFOs (rate knobs are normalized 0..1 -> Hz)
  gainLFORate: {
    label: 'Amp LFO Rate',
    min: 0,
    max: 1,
    defaultValue: 0.1,
    curve: 5,
    apply: (p, v) => p.gainLFO?.setFrequency(v * 100 + 0.1),
  },
  gainLFODepth: {
    label: 'Amp LFO Depth',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 1.5,
    apply: (p, v) => p.gainLFO?.setDepth(v),
  },
  pitchLFORate: {
    label: 'Pitch LFO Rate',
    min: 0,
    max: 1,
    defaultValue: 0.01,
    curve: 5,
    apply: (p, v) => p.pitchLFO?.setFrequency(v * 100 + 0.1),
  },
  pitchLFODepth: {
    label: 'Pitch LFO Depth',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 1.5,
    apply: (p, v) => p.pitchLFO?.setDepth(v / 10),
  },

  // Trim / loop. Normalized 0..1 as a fraction of the loaded sample's duration:
  // apply() converts to seconds, so the control range never depends on the sample.
  trimStart: {
    label: 'Start',
    min: 0,
    max: 1,
    defaultValue: 0,
    step: 0.001,
    format: seconds,
    apply: (p, v) => p.setSampleStartPoint(v * p.sampleDuration),
  },
  trimEnd: {
    label: 'End',
    min: 0,
    max: 1,
    defaultValue: 1,
    step: 0.001,
    format: seconds,
    apply: (p, v) => p.setSampleEndPoint(v * p.sampleDuration),
  },
  loopStart: {
    label: 'Loop Start',
    min: 0,
    max: 1,
    defaultValue: 0,
    step: 0.001,
    format: seconds,
    apply: (p, v) => p.setLoopStart(v * p.sampleDuration),
  },
  loopDuration: {
    label: 'Loop Length',
    min: 0,
    max: 1,
    defaultValue: 1,
    curve: 4,
    format: (v, duration) => {
      const s = v * duration;
      return s <= 0.061 ? `${(s * 1000).toFixed(0)}ms` : `${s.toFixed(2)} s`;
    },
    apply: (p, v) => p.setLoopDuration(v * p.sampleDuration),
  },
  // Todo: Decide whether all params should be returned or just those requested by app (add param?)
  loopEnd: {
    label: 'Loop End',
    min: 0,
    max: 1,
    defaultValue: 1,
    step: 0.001,
    format: seconds,
    apply: (p, v) => p.setLoopEnd(v * p.sampleDuration),
  },
  loopRampDuration: {
    label: 'Loop Ramp',
    min: 0.001,
    max: 1,
    defaultValue: 0.5,
    step: 0.001,
    apply: (p, v) => p.setLoopRampDuration(v),
  },
  loopDurationDrift: {
    label: 'Loop Drift',
    min: 0,
    max: 1,
    defaultValue: 0.3,
    step: 0.001,
    curve: 0.5,
    format: (v) => `${(v * 100).toFixed(1)}%`,
    apply: (p, v) => p.setLoopDurationDriftAmount(v),
  },
  keytrackLoop: {
    label: 'KeyTrack',
    min: 0,
    max: 1,
    defaultValue: 0,
    format: pct,
    apply: (p, v) => p.setKeytrackLoopAmount(v),
  },
});

export type SamplerParamKey = keyof typeof samplerParams;
export type SamplerParamValues = Record<SamplerParamKey, number>;
export type SamplerParamPatch = Partial<SamplerParamValues>;
