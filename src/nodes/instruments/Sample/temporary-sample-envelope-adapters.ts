import {
  envelopePresets,
  hasVariation,
  type AutomatableParam,
  type EnvelopeShape,
  type EnvelopeRuntime,
  type EnvelopeRuntimeTriggerOptions,
  type EnvelopeConfig,
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

export function createDefaultSampleEnvelopeConfig(
  id: SampleEnvelopeId,
  durationSeconds: number,
): EnvelopeConfig {
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
): Pick<EnvelopeRuntimeTriggerOptions, 'amount' | 'envelope'> {
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

export function getPostFilterEnvelopeOptions(config: EnvelopeConfig, amount: number) {
  return {
    amount: config.enabled ? amount : 0,
    timeScale: config.timeScale,
  };
}

export function getLiveSampleEnvelopeSustainValue(
  id: SampleEnvelopeId,
  config: EnvelopeConfig,
): number | undefined {
  const { mode } = config.envelope;
  if (id === 'filter-env' || mode.type !== 'sustain') return undefined;
  return config.envelope.points[mode.at].value;
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
