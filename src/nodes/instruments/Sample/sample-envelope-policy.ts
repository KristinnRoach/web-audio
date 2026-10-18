import {
  envelopePresets,
  hasVariation,
  setDuration,
  type Envelope,
  type EnvelopeShape,
  type EnvelopeTriggerOptions,
} from '@/nodes/params/envelopes';
import type { EnvelopeConfig } from './envelope-config';

/**
 * Sampler defaults, parameter mapping and live-edit decisions.
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
 * so amount 1 can open any cutoff fully. The spec only gives the detuned frequency a
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
        amount: 1,
        enabled: true,
        timeScale: 1,
        playbackRateSync: false,
        shape: envelopePresets.amplitude(durationSeconds),
      };
    case 'pitch':
      return {
        amount: 1,
        enabled: false,
        timeScale: 1,
        playbackRateSync: false,
        shape: flatPitchShape(durationSeconds),
      };
    case 'filter':
      return {
        amount: 1,
        enabled: false,
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

export function shouldTriggerSampleEnvelope(id: SampleEnvelopeId, config: EnvelopeConfig) {
  return config.enabled && (id !== 'pitch' || hasVariation(config.shape.points));
}

/** A note without a velocity plays at full level. */
function velocityGain(velocity?: number) {
  return velocity === undefined ? 1 : velocity / 127;
}

/**
 * Where an envelope's param rests while that envelope is off: amp gates at the note's
 * velocity, and pitch and filter detune return to 0, leaving the note's rate and the
 * cutoff on their own params.
 */
export function getSampleEnvelopeRestValue(id: SampleEnvelopeId, velocity?: number): number {
  return id === 'amp' ? velocityGain(velocity) : 0;
}

/** The trigger options that place a sampler envelope's shape on its param. */
export function resolveSampleEnvelopeTrigger(
  id: SampleEnvelopeId,
  { velocity, amount = 1 }: { velocity?: number; amount?: number } = {},
): Pick<EnvelopeTriggerOptions, 'amount' | 'curve'> {
  if (id === 'amp') return { amount: velocityGain(velocity) * amount };
  // Linear in cents is exponential in Hz, so the preset's exponential curves would bend it twice.
  if (id === 'pitch') return { amount: PITCH_ENVELOPE_SEMITONES * 100 * amount, curve: 'linear' };
  return { amount: FILTER_ENVELOPE_OCTAVES * 1200 * amount, curve: 'linear' };
}

/** Applies an envelope edit at the next loop boundary, when one exists. */
function applyOnNextEnvLoopCycle(
  envelope: Envelope,
  apply: () => void,
  retrigger: (at: number) => void,
): void {
  const at = envelope.nextCycleTime();
  apply();
  if (at !== null) retrigger(at);
}

/** Applies a sampler shape edit without interrupting an existing loop mid-cycle. */
export function applySampleEnvelopeShapeEdit(
  envelope: Envelope,
  nextShape: EnvelopeShape,
  apply: () => void,
  retrigger: (at: number, fromPoint: number) => void,
): void {
  // A non-looping run has no cycle boundary. When loop is switched on, resume from the
  // last point it reached so a sustained run carries on into its first full cycle.
  const resumeFrom =
    nextShape.mode.type === 'loop' && envelope.shape.mode.type !== 'loop'
      ? envelope.currentPoint()
      : null;
  if (resumeFrom !== null) {
    apply();
    retrigger(envelope.clock.currentTime, resumeFrom);
    return;
  }

  applyOnNextEnvLoopCycle(envelope, apply, (at) => retrigger(at, 0));
}
