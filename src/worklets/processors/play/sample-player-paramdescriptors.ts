import type { AudioParamDescriptor } from '../../../types/audio-param-descriptor';

// Source of truth for SamplePlayerProcessor's parameterDescriptors.
// Plain data (no AudioWorkletProcessor reference) so it's safe to import
// from both the worklet processor and main-thread code.
export const SAMPLE_PLAYER_WORKLET_AUDIOPARAMS = {
  masterGain: {
    name: 'masterGain',
    defaultValue: 1,
    minValue: 0,
    maxValue: 2,
    automationRate: 'k-rate',
  },
  envGain: {
    name: 'envGain',
    defaultValue: 0,
    minValue: 0,
    maxValue: 1,
    automationRate: 'a-rate',
  },
  velocity: {
    name: 'velocity',
    defaultValue: 100,
    minValue: 0,
    maxValue: 127,
    automationRate: 'k-rate',
  },
  pan: {
    name: 'pan',
    defaultValue: 0,
    minValue: -1, // -1 hard left
    maxValue: 1, // 1 hard right
    automationRate: 'k-rate',
  },
  playbackRate: {
    name: 'playbackRate',
    defaultValue: 1,
    minValue: 0.1,
    maxValue: 24,
    automationRate: 'a-rate',
  },
  // NOTE: Time based params use seconds
  loopStart: {
    name: 'loopStart',
    defaultValue: 0,
    minValue: 0,
    maxValue: 99999, // Max sample length in seconds
    automationRate: 'k-rate',
  },
  loopEnd: {
    name: 'loopEnd',
    defaultValue: 99999, // Will be set to actual buffer duration when loaded
    minValue: 0,
    maxValue: 99999,
    automationRate: 'k-rate',
  },
  startPoint: {
    name: 'startPoint',
    defaultValue: 0,
    minValue: 0,
    maxValue: 9999, // Max sample length in seconds
    automationRate: 'k-rate',
  },
  endPoint: {
    name: 'endPoint',
    defaultValue: 9999, // Will be set to actual buffer duration when loaded
    minValue: 0,
    maxValue: 9999,
    automationRate: 'k-rate',
  },
  playbackPosition: {
    name: 'playbackPosition',
    defaultValue: 0,
    minValue: 0,
    maxValue: 99999,
    automationRate: 'k-rate',
  },
  loopDurationDriftAmount: {
    name: 'loopDurationDriftAmount',
    defaultValue: 0,
    minValue: 0,
    maxValue: 1, // 0 = no drift, 1 = max drift (up to 100% of loop duration)
    automationRate: 'k-rate',
  },
  maxLoopCount: {
    name: 'maxLoopCount',
    defaultValue: 999999,
    minValue: 1,
    maxValue: 999999,
    automationRate: 'k-rate',
  },
  tempo: {
    name: 'tempo',
    defaultValue: 120,
    minValue: 20,
    maxValue: 300,
    automationRate: 'k-rate',
  },
} as const satisfies Record<string, AudioParamDescriptor>;

export const SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS = Object.values(
  SAMPLE_PLAYER_WORKLET_AUDIOPARAMS,
);

export type SamplePlayerWorkletAudioParamKey =
  keyof typeof SAMPLE_PLAYER_WORKLET_AUDIOPARAMS;
