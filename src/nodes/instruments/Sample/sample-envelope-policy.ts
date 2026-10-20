import {
  envelopePresets,
  setDuration,
  type EnvelopeShape,
  type EnvelopeTriggerOptions,
} from '@/nodes/modulators/envelope';
import type { EnvelopeConfig } from './envelope-config';

/**
 * Sampler defaults, parameter mapping and trigger options.
 * Envelope owns scheduling; unfinished behavior is tracked in envelopes/KNOWN-ISSUES.md.
 */

export const SAMPLE_ENVELOPE_IDS = ['amp', 'pitch', 'filter'] as const;
export type SampleEnvelopeId = (typeof SAMPLE_ENVELOPE_IDS)[number];

export function getSampleEnvelopeIds(hasVoiceFilter: boolean): readonly SampleEnvelopeId[] {
  return hasVoiceFilter ? SAMPLE_ENVELOPE_IDS : ['amp', 'pitch'];
}

/**
 * Pitch shape values are bipolar: -1..1 spans this many semitones down..up, 0 is unison.
 * ponytail: fixed range; make it configurable once there is a place to persist it.
 */
const PITCH_ENVELOPE_SEMITONES = 12;

/**
 * Filter shape value 1 detunes the cutoff up by this many octaves, about the audible range,
 * so depth 1 can open any cutoff fully. The spec only gives the detuned frequency a
 * nominal range of [0, Nyquist]; going past it relies on browsers clamping.
 * ponytail: fixed depth; make it configurable alongside the pitch range.
 */
const FILTER_ENVELOPE_OCTAVES = 10;

/** Flat at 0, so the pitch env is an identity until someone edits it. */
function flatPitchShape(durationSeconds: number): EnvelopeShape {
  return {
    mode: { type: 'once' },
    sustainPoint: 0,
    points: setDuration(
      [
        { time: 0, value: 0, curve: 'exponential' },
        { time: 1, value: 0, curve: 'exponential' },
      ],
      durationSeconds,
    ),
    releasePoint: 0,
  };
}

export function createDefaultSampleEnvelopeConfig(
  id: SampleEnvelopeId,
  durationSeconds: number,
): EnvelopeConfig {
  switch (id) {
    case 'amp':
      return {
        depth: 1,
        enabled: true,
        timeScale: 1,
        playbackRateSync: false,
        shape: envelopePresets.amplitude(durationSeconds),
      };
    case 'pitch':
      return {
        depth: 1,
        enabled: true,
        timeScale: 1,
        playbackRateSync: false,
        shape: flatPitchShape(durationSeconds),
      };
    case 'filter':
      return {
        depth: 0.5,
        enabled: true,
        timeScale: 1,
        playbackRateSync: false,
        shape: envelopePresets.filter(durationSeconds),
      };
  }
}

export function getSampleEnvelopeParamName(id: SampleEnvelopeId): string {
  switch (id) {
    case 'amp':
      return 'envGain';
    case 'pitch':
      return 'detune';
    case 'filter':
      return 'lpfDetune';
  }
}

/** Amp rests at unity; velocity is applied once by the processor. Detune rests at zero. */
export function getSampleEnvelopeRestValue(id: SampleEnvelopeId): number {
  return id === 'amp' ? 1 : 0;
}

/** Resolve sampler units and timing before handing a run to the generic scheduler. */
export function resolveSampleEnvelopeTrigger(
  id: SampleEnvelopeId,
  config: EnvelopeConfig,
  playbackRate: number,
): Pick<EnvelopeTriggerOptions, 'depth' | 'curve' | 'timeScale'> {
  const options = {
    depth: config.depth ?? 1,
    timeScale: config.timeScale * (config.playbackRateSync ? playbackRate : 1),
  };
  if (id === 'amp') return options;
  // Linear in cents is exponential in Hz, so the preset's exponential curves would bend it twice.
  if (id === 'pitch') {
    return { ...options, depth: PITCH_ENVELOPE_SEMITONES * 100 * options.depth, curve: 'linear' };
  }
  return { ...options, depth: FILTER_ENVELOPE_OCTAVES * 1200 * options.depth, curve: 'linear' };
}
