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
 * Per-target units. `range` is the default `EnvelopeConfig.range`; `rest` is the target value
 * that leaves it unmodulated. Bipolar shapes map -1..0..1 onto min..rest..max piecewise.
 * Filter 12000 cents (10 octaves, about the audible range) lets depth 1 open any cutoff fully;
 * the spec only gives the detuned frequency a nominal range of [0, Nyquist], so going past it
 * relies on browsers clamping.
 * `linear` replaces non-step curves: pitch and filter are cents, already exponential in Hz,
 * and pan is bipolar, which exponential curves can't cross.
 */
const SAMPLE_ENVELOPE_UNITS: Record<
  SampleEnvelopeId,
  { range: readonly [number, number]; rest: number; bipolar: boolean; linear: boolean }
> = {
  amp: { range: [0, 1], rest: 1, bipolar: false, linear: false },
  pan: { range: [-1, 1], rest: 0, bipolar: true, linear: true },
  pitch: { range: [-1200, 1200], rest: 0, bipolar: true, linear: true },
  filter: { range: [0, 12000], rest: 0, bipolar: false, linear: true },
};

/**
 * Config in the processor target's units, `base + depth * shape` (`negativeDepth` below 0),
 * mixed by depth from rest to the shape mapped onto the range, with any curve override
 * applied. Timing stays unresolved; the processor applies it per note.
 */
export function resolveSampleEnvelopeForProcessor(
  id: SampleEnvelopeId,
  config: EnvelopeConfig,
): EnvelopeConfig & { base: number; negativeDepth?: number } {
  const units = SAMPLE_ENVELOPE_UNITS[id];
  const { rest, bipolar, linear } = units;
  const [min, max] = config.range ?? units.range;
  const depth = config.depth ?? 1;
  const points = linear
    ? config.shape.points.map((point) =>
        point.curve === 'step' ? point : { ...point, curve: 'linear' as const },
      )
    : config.shape.points;
  const shape = { ...config.shape, points };
  // rest + depth * (mapped - rest), folded into the processor's base + depth * shape.
  return bipolar
    ? {
        ...config,
        base: rest * (1 - depth),
        depth: depth * (max - rest),
        negativeDepth: depth * (rest - min),
        shape,
      }
    : {
        ...config,
        base: rest * (1 - depth) + depth * min,
        depth: depth * (max - min),
        shape,
      };
}
