import {
  envelopePresets,
  setDuration,
  type EnvelopeShape,
  type EnvelopeTriggerOptions,
} from '@/nodes/modulators/envelope';
import type { EnvelopeConfig } from './envelope-config';

/**
 * Sampler defaults and units for the envelopes the sample-player processor plays.
 */

export const SAMPLE_ENVELOPE_IDS = ['amp', 'pitch', 'filter', 'pan'] as const;
export type SampleEnvelopeId = (typeof SAMPLE_ENVELOPE_IDS)[number];

export function getSampleEnvelopeIds(hasVoiceFilter: boolean): readonly SampleEnvelopeId[] {
  return hasVoiceFilter ? SAMPLE_ENVELOPE_IDS : ['amp', 'pitch', 'pan'];
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

/** Flat at 0, so a bipolar env (pitch, pan) is an identity until someone edits it. */
function flatBipolarShape(durationSeconds: number): EnvelopeShape {
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
        loopSync: false,
        shape: envelopePresets.amplitude(durationSeconds),
      };
    case 'pitch':
      return {
        depth: 1,
        enabled: true,
        timeScale: 1,
        playbackRateSync: false,
        loopSync: false,
        shape: flatBipolarShape(durationSeconds),
      };
    case 'pan':
      return {
        depth: 1,
        enabled: true,
        timeScale: 1,
        playbackRateSync: false,
        loopSync: false,
        shape: flatBipolarShape(durationSeconds),
      };
    case 'filter':
      return {
        depth: 0.5,
        enabled: true,
        timeScale: 1,
        playbackRateSync: false,
        loopSync: false,
        shape: envelopePresets.filter(durationSeconds),
      };
  }
}

/** Processor target; 'filter' goes out on the processor's second output to lpf.detune. */
export function getSampleEnvelopeProcessorTarget(
  id: SampleEnvelopeId,
): 'gain' | 'detune' | 'pan' | 'filter' {
  return id === 'amp' ? 'gain' : id === 'pitch' ? 'detune' : id;
}

/**
 * Config in the processor target's units: depth resolved and any curve override
 * applied to the shape. Timing stays unresolved; the processor applies it per note.
 */
export function resolveSampleEnvelopeForProcessor(
  id: SampleEnvelopeId,
  config: EnvelopeConfig,
): EnvelopeConfig {
  const { depth, curve } = resolveSampleEnvelopeUnits(id, config);
  const points = curve
    ? config.shape.points.map((point) => (point.curve === 'step' ? point : { ...point, curve }))
    : config.shape.points;
  return { ...config, depth, shape: { ...config.shape, points } };
}

/** Resolve sampler units: depth in the target's units and any curve override. */
function resolveSampleEnvelopeUnits(
  id: SampleEnvelopeId,
  config: EnvelopeConfig,
): Pick<EnvelopeTriggerOptions, 'depth' | 'curve'> {
  const options = { depth: config.depth ?? 1 };
  if (id === 'amp') return options;
  // Bipolar, -1..1 is hard left..right; exponential curves can't cross zero.
  if (id === 'pan') return { ...options, curve: 'linear' };
  // Linear in cents is exponential in Hz, so the preset's exponential curves would bend it twice.
  if (id === 'pitch') {
    return { ...options, depth: PITCH_ENVELOPE_SEMITONES * 100 * options.depth, curve: 'linear' };
  }
  return { ...options, depth: FILTER_ENVELOPE_OCTAVES * 1200 * options.depth, curve: 'linear' };
}
