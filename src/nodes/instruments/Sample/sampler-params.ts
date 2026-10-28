// Parameter descriptors for SamplePlayer.
// UI-agnostic metadata (range, default, taper, formatting) plus an apply()
// mapping a normalized-or-natural knob value onto the player. Lets any
// frontend render controls without hardcoding per-param knowledge.
import { maxSafeHz } from '@/nodes/params/audioparam-utils';

import type { SamplePlayer } from './SamplePlayer';

const PITCH_LFO_MAX_CENTS = 200; // cents = semitones * 100

export interface SamplerParamDescriptor {
  label: string;
  min: number;
  max: number;
  /**
   * Suggested initial control position. Not applied automatically: the player starts
   * from its own internal state, which can differ. Call `apply(player, defaultValue)`
   * to make the player match.
   */
  defaultValue: number;
  /**
   * Control taper: `value = min + (max - min) * position ** curve`, position in [0, 1].
   * 1 (default) = linear, >1 = finer control near min, <1 = finer control near max.
   */
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

/** Control position in [0, 1] for a value: inverse of the `curve` taper. */
export const samplerParamPosition = (d: SamplerParamDescriptor, v: number) =>
  ((v - d.min) / (d.max - d.min)) ** (1 / (d.curve ?? 1));

const percent = (v: number) => `${(v * 100).toFixed(0)}%`;
/** Readout of the knob position, not the value: a curved knob reads 50% at its middle. */
const positionPercent =
  (key: string) =>
  (v: number): string =>
    percent(samplerParamPosition(samplerParams[key as keyof typeof samplerParams], v));
const hz = (v: number) => (v >= 1 ? `${v.toFixed(1)}Hz` : `${v.toFixed(2)}Hz`);
const kHz = (v: number) => `${(v / 1000).toFixed(1)}kHz`;
const hzOrKhz = (v: number) => (v >= 1000 ? kHz(v) : hz(v));

/** Normalized position -> seconds readout */
const seconds = (v: number, duration: number) => `${(v * duration).toFixed(2)}s`;
const milliseconds = (v: number, duration: number) => {
  const ms = v * duration * 1000;
  return `${ms.toFixed(Math.abs(ms) < 10 ? 1 : 0)}ms`;
};
const secondsOrMilliseconds = (v: number, duration: number) =>
  Math.abs(v * duration) < 1 ? milliseconds(v, duration) : seconds(v, duration);

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
    format: positionPercent('volume'),
    apply: (p, v) => p.setVolume(v),
  },
  dryWet: {
    label: 'Dry/Wet',
    min: 0,
    max: 1,
    defaultValue: 0.5,
    format: positionPercent('dryWet'),
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
    format: (v) => `${v.toFixed(0)}BPM`,
    apply: (p, v) => p.setTempo(v),
  },

  // Filters
  lowpassFilter: {
    label: 'LPF',
    min: 40,
    max: maxSafeHz(),
    defaultValue: maxSafeHz(),
    curve: 5,
    format: hzOrKhz,
    apply: (p, v) => p.setLpfCutoff(v),
  },
  highpassFilter: {
    label: 'HPF',
    min: 20,
    max: maxSafeHz(),
    defaultValue: 40,
    curve: 5,
    format: hzOrKhz,
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
    format: positionPercent('feedback'),
    apply: (p, v) => p.setFeedbackAmount(v),
  },
  feedbackPitch: {
    label: 'FB-Pitch',
    min: 0.25,
    max: 4,
    defaultValue: 0.5,
    allowedValues: [0.25, 0.5, 1, 2, 3, 4],
    curve: 2,
    apply: (p, v) => p.setFeedbackPitchScale(v),
  },
  feedbackDecay: {
    label: 'FB-Decay',
    min: 0.01,
    max: 1,
    defaultValue: 0.15,
    curve: 1.5,
    format: positionPercent('feedbackDecay'),
    apply: (p, v) => p.setFeedbackDecay(v),
  },
  feedbackLpf: {
    label: 'FB-LPF',
    min: 400,
    max: 16000,
    defaultValue: 6000,
    curve: 5,
    format: hzOrKhz,
    apply: (p, v) => p.setFeedbackLowpassCutoff(v),
  },

  // Dirt
  distortion: {
    label: 'Distortion',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 1.5,
    format: positionPercent('distortion'),
    apply: (p, v) => p.setDistortionMacro(v),
  },
  drive: {
    label: 'Drive',
    min: 0,
    max: 1,
    defaultValue: 0,
    format: positionPercent('drive'),
    apply: (p, v) => p.setDrive(v),
  },
  clipping: {
    label: 'Clipping',
    min: 0,
    max: 1,
    defaultValue: 0,
    format: positionPercent('clipping'),
    apply: (p, v) => p.setClippingMacro(v),
  },
  amMod: {
    label: 'AM',
    min: 0,
    max: 1,
    defaultValue: 0,
    format: positionPercent('amMod'),
    apply: (p, v) => p.setModulationDepth('AM', v),
  },
  amModOctaveOffset: {
    label: 'AM Octave',
    min: -4,
    max: 3,
    defaultValue: 1,
    step: 1,
    apply: (p, v) => p.setAMModOctaveOffset(v),
  },

  // Sends / space
  reverbSend: {
    label: 'Reverb Send',
    min: 0,
    max: 1,
    defaultValue: 0,
    format: positionPercent('reverbSend'),
    apply: (p, v) => p.sendToFx('reverb', v),
  },
  reverbSize: {
    label: 'Reverb Size',
    min: 0,
    max: 1,
    defaultValue: 0.5,
    format: positionPercent('reverbSize'),
    apply: (p, v) => p.setReverbAmount(v),
  },
  delaySend: {
    label: 'Delay Send',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 2,
    format: positionPercent('delaySend'),
    apply: (p, v) => p.sendToFx('delay', v),
  },
  delayTime: {
    label: 'Delay Time',
    min: 0.005,
    max: 1.5,
    defaultValue: 0.1,
    curve: 2,
    format: (v) => `${v.toFixed(3)}s`,
    apply: (p, v) => p.setDelayTime(v),
  },
  delayFeedback: {
    label: 'Delay Feedback',
    min: 0,
    max: 1,
    defaultValue: 0.2,
    curve: 1,
    format: positionPercent('delayFeedback'),
    apply: (p, v) => p.setDelayFeedback(v),
  },

  // LFOs (rate knobs are normalized 0..1 -> Hz)
  gainLFORate: {
    label: 'Amp LFO Rate',
    min: 0,
    max: 1,
    defaultValue: 0.03,
    curve: 5,
    format: (v) => hzOrKhz(v * 100 + 0.1),
    apply: (p, v) => p.gainLFO?.setFrequency(v * 100 + 0.1),
  },
  gainLFODepth: {
    label: 'Amp LFO Depth',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 1.5,
    format: positionPercent('gainLFODepth'),
    apply: (p, v) => p.gainLFO?.setDepth(v),
  },
  pitchLFORate: {
    label: 'Pitch LFO Rate',
    min: 0,
    max: 1,
    defaultValue: 0.015,
    curve: 5,
    format: (v) => hzOrKhz(v * 100 + 0.1),
    apply: (p, v) => p.pitchLFO?.setFrequency(v * 100 + 0.1),
  },
  pitchLFODepth: {
    label: 'Pitch LFO Depth',
    min: 0,
    max: 1,
    defaultValue: 0,
    curve: 2,
    format: (v) => `${(v * PITCH_LFO_MAX_CENTS).toFixed(0)} cents`,
    apply: (p, v) => p.pitchLFO?.setDepth(v * PITCH_LFO_MAX_CENTS),
  },

  // Trim / loop. Fractions of the loaded sample's duration (loop length is signed):
  // apply() converts to seconds, so the control range never depends on the sample.
  trimStart: {
    label: 'Start',
    min: 0,
    max: 1,
    defaultValue: 0,
    step: 0.001,
    format: secondsOrMilliseconds,
    apply: (p, v) => p.setSampleStartPoint(v * p.sampleDuration),
  },
  trimEnd: {
    label: 'End',
    min: 0,
    max: 1,
    defaultValue: 1,
    step: 0.001,
    format: secondsOrMilliseconds,
    apply: (p, v) => p.setSampleEndPoint(v * p.sampleDuration),
  },
  loopStart: {
    label: 'Loop Start',
    min: 0,
    max: 1,
    defaultValue: 0,
    step: 0.00001,
    curve: 1,
    format: secondsOrMilliseconds,
    apply: (p, v) => p.setLoopStart(v * p.sampleDuration),
  },
  loopEnd: {
    label: 'Loop End',
    min: 0,
    max: 1,
    defaultValue: 1,
    step: 0.00001,
    curve: 1,
    format: secondsOrMilliseconds,
    apply: (p, v) => p.setLoopEnd(v * p.sampleDuration),
  },
  loopDuration: {
    label: 'Loop Length',
    min: -1,
    max: 1,
    defaultValue: 1,
    curve: 1,
    format: secondsOrMilliseconds,
    apply: (p, v) => p.setLoopDuration(v * p.sampleDuration),
  },
  loopRampDuration: {
    label: 'Loop Ramp',
    min: 0,
    max: 0.5,
    defaultValue: 0.125, // Keep equal to the processor's initial loopRampDuration.
    step: 0.001,
    format: positionPercent('loopRampDuration'),
    apply: (p, v) => p.setLoopRampDuration(v),
  },
  loopDurationDrift: {
    label: 'Loop Drift',
    min: 0,
    max: 1,
    defaultValue: 0.07,
    step: 0.0001,
    curve: 2,
    format: positionPercent('loopDurationDrift'),
    apply: (p, v) => p.setLoopDurationDriftAmount(v),
  },
  keytrackLoop: {
    label: 'KeyTrack',
    min: 0,
    max: 1,
    defaultValue: 0,
    step: 0.01,
    curve: 1,
    format: positionPercent('keytrackLoop'),
    apply: (p, v) => p.setKeytrackLoopAmount(v),
  },
  transpose: {
    label: 'Transpose',
    min: -12,
    max: 12,
    defaultValue: 0,
    step: 1,
    apply: (p, v) => p.transpose(v),
  },
  fineTune: {
    label: 'Fine Tune',
    min: -50,
    max: 50,
    defaultValue: 0,
    step: 1,
    format: (v) => `${v.toFixed(0)} cents`,
    apply: (p, v) => p.fineTune(v),
  },
});

export type SamplerParamKey = keyof typeof samplerParams;
export type SamplerParamValues = Record<SamplerParamKey, number>;
export type SamplerParams = Partial<SamplerParamValues>;

/** @deprecated Renamed to {@link SamplerParams}. Removed in the next minor. */
export type SamplerParamPatch = SamplerParams;
