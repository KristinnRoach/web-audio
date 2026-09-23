import {
  envelopePresets,
  hasVariation,
  setDuration,
  type AutomatableParam,
  type Envelope,
  type EnvelopeShape,
  type EnvelopeTriggerOptions,
} from '@/nodes/params/envelopes';
import type { EnvelopeConfig } from './envelope-config';

type RangedAutomatableParam = AutomatableParam & { readonly maxValue: number };

/**
 * Temporary sampler policy around the generic envelope runtime.
 * Keep these functions pure so each can either disappear or move independently.
 */

export const SAMPLE_ENVELOPE_IDS = ['amp-env', 'pitch-env', 'filter-env'] as const;
export type SampleEnvelopeId = (typeof SAMPLE_ENVELOPE_IDS)[number];

export function getSampleEnvelopeIds(hasVoiceFilter: boolean): readonly SampleEnvelopeId[] {
  return hasVoiceFilter ? SAMPLE_ENVELOPE_IDS : ['amp-env', 'pitch-env'];
}

/** Flat at 1, so the pitch env is an identity until someone edits it. */
function flatPitchShape(durationSeconds: number): EnvelopeShape {
  return {
    mode: { type: 'once' },
    sustain: 0,
    points: setDuration(
      [
        { time: 0, value: 1, curve: 'exponential' },
        { time: 1, value: 1, curve: 'exponential' },
      ],
      durationSeconds,
    ),
    release: 0,
  };
}

export function createDefaultSampleEnvelopeConfig(
  id: SampleEnvelopeId,
  durationSeconds: number,
): EnvelopeConfig {
  switch (id) {
    case 'amp-env':
      return { enabled: true, timeScale: 1, envelope: envelopePresets.amplitude(durationSeconds) };
    case 'pitch-env':
      return { enabled: false, timeScale: 1, envelope: flatPitchShape(durationSeconds) };
    case 'filter-env':
      return { enabled: false, timeScale: 1, envelope: envelopePresets.filter(durationSeconds) };
  }
}

export function getSampleEnvelopeParamName(id: SampleEnvelopeId): string {
  switch (id) {
    case 'amp-env':
      return 'envGain';
    case 'pitch-env':
      return 'playbackRate';
    case 'filter-env':
      return 'lpf';
  }
}

export function shouldTriggerSampleEnvelope(id: SampleEnvelopeId, config: EnvelopeConfig) {
  return config.enabled && (id !== 'pitch-env' || hasVariation(config.envelope.points));
}

export function getSampleEnvelopeBaseValue(
  id: SampleEnvelopeId,
  values: { velocity?: number; playbackRate: number; filterCutoff: number },
): number {
  switch (id) {
    case 'amp-env':
      return values.velocity === undefined ? 1 : values.velocity / 127;
    case 'pitch-env':
      return values.playbackRate;
    case 'filter-env':
      return values.filterCutoff;
  }
}

export function resolveSampleEnvelopeTrigger(
  id: SampleEnvelopeId,
  envelope: EnvelopeShape,
  baseValue: number,
  param: RangedAutomatableParam,
): Pick<EnvelopeTriggerOptions, 'amount' | 'shape'> {
  if (id !== 'filter-env') return { amount: baseValue };

  const low = Math.max(baseValue, 1e-3);
  const high = Math.max(param.maxValue, low);
  const logLow = Math.log(low);
  const logRange = Math.log(high) - logLow;
  const points = envelope.points.map((point) => ({
    ...point,
    value: Math.exp(logLow + logRange * point.value),
    curve: 'exponential' as const,
  }));

  return { shape: { ...envelope, points } };
}

export function getLiveSampleEnvelopeSustainValue(
  id: SampleEnvelopeId,
  config: EnvelopeConfig,
): number | undefined {
  const { mode, sustain } = config.envelope;
  if (id === 'filter-env' || mode.type !== 'sustain') return undefined;
  return config.envelope.points[sustain].value;
}

/** Applies an envelope edit at the next inaudible loop boundary, when one exists. */
export function applyOnNextEnvLoopCycle(
  envelope: Envelope,
  apply: () => void,
  retrigger: (at: number) => void,
): void {
  const at = envelope.nextCycleTime();
  apply();
  if (at !== null) retrigger(at);
}
