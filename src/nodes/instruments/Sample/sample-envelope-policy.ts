import { envelopePresets, setDuration, type EnvelopeShape } from '@/nodes/modulators/envelope';
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
  return {
    depth: id === 'filter' ? 0.5 : 1,
    enabled: true,
    timeScale: 1,
    playbackRateSync: false,
    loopSync: false,
    shape:
      id === 'amp'
        ? envelopePresets.amplitude(durationSeconds)
        : id === 'filter'
          ? envelopePresets.filter(durationSeconds)
          : flatBipolarShape(durationSeconds),
  };
}

/** Processor target; 'filter' goes out on the processor's second output to lpf.detune. */
export function getSampleEnvelopeProcessorTarget(
  id: SampleEnvelopeId,
): 'gain' | 'detune' | 'pan' | 'filter' {
  return id === 'amp' ? 'gain' : id === 'pitch' ? 'detune' : id;
}

/**
 * Per-target units. `scale` maps shape units to the target's units; `rest` is the shape
 * value that leaves the target unmodulated. Depth mixes from rest (0) to the full shape (1).
 * `linear` replaces non-step curves: pitch and filter are cents, already exponential in Hz,
 * and pan is bipolar, which exponential curves can't cross.
 */
const SAMPLE_ENVELOPE_UNITS: Record<
  SampleEnvelopeId,
  { scale: number; rest: number; linear: boolean }
> = {
  amp: { scale: 1, rest: 1, linear: false },
  pan: { scale: 1, rest: 0, linear: true },
  pitch: { scale: PITCH_ENVELOPE_SEMITONES * 100, rest: 0, linear: true },
  filter: { scale: FILTER_ENVELOPE_OCTAVES * 1200, rest: 0, linear: true },
};

/**
 * Config in the processor target's units, `base + depth * shape`, with any curve override
 * applied. Timing stays unresolved; the processor applies it per note.
 */
export function resolveSampleEnvelopeForProcessor(
  id: SampleEnvelopeId,
  config: EnvelopeConfig,
): EnvelopeConfig & { base: number } {
  const { scale, rest, linear } = SAMPLE_ENVELOPE_UNITS[id];
  const depth = config.depth ?? 1;
  const points = linear
    ? config.shape.points.map((point) =>
        point.curve === 'step' ? point : { ...point, curve: 'linear' as const },
      )
    : config.shape.points;
  return {
    ...config,
    base: scale * rest * (1 - depth),
    depth: scale * depth,
    shape: { ...config.shape, points },
  };
}
