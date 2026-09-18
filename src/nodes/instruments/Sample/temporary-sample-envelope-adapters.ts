import {
  envelopePresets,
  hasVariation,
  type AutomatableParam,
  type Envelope,
  type EnvelopeRuntime,
  type EnvelopeRuntimeTriggerOptions,
  type EnvelopeSettings,
} from '@/nodes/params/envelopes';

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

export function createDefaultSampleEnvelopeSettings(
  id: SampleEnvelopeId,
  durationSeconds: number,
): EnvelopeSettings {
  switch (id) {
    case 'amp-env':
      return envelopePresets.amplitude(durationSeconds);
    case 'pitch-env':
      return envelopePresets.pitch(durationSeconds);
    case 'filter-env':
      return envelopePresets.filter(durationSeconds);
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

export function shouldTriggerSampleEnvelope(id: SampleEnvelopeId, settings: EnvelopeSettings) {
  return settings.enabled && (id !== 'pitch-env' || hasVariation(settings.envelope));
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
  envelope: Envelope,
  baseValue: number,
  param: RangedAutomatableParam,
): EnvelopeRuntimeTriggerOptions {
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

  return { envelope: { ...envelope, points } };
}

export function getPostFilterEnvelopeOptions(settings: EnvelopeSettings, amount: number) {
  return {
    amount: settings.enabled ? amount : 0,
    timeScale: settings.timeScale,
  };
}

export function getLiveSampleEnvelopeSustainValue(
  id: SampleEnvelopeId,
  settings: EnvelopeSettings,
): number | undefined {
  const { sustain } = settings.envelope;
  if (id === 'filter-env' || sustain === undefined) return undefined;
  return settings.envelope.points[sustain].value;
}

/** Applies an envelope edit at the next inaudible loop boundary, when one exists. */
export function applyOnNextEnvLoopCycle(
  runtime: EnvelopeRuntime,
  apply: () => void,
  retrigger: (at: number) => void,
): void {
  const at = runtime.nextCycleTime();
  apply();
  if (at !== null) retrigger(at);
}
