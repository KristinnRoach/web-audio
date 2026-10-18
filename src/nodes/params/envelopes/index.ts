export {
  Envelope,
  type EnvelopeClock,
  type EnvelopeScaling,
  type EnvelopeTriggerOptions,
  type SetBaseOptions,
} from './Envelope';
export type { AutomatableParam } from './envelope-scheduling';
export {
  assertValidEnvelopeShape,
  hasVariation,
  setDuration,
  type EnvelopeMode,
  type EnvelopePoint,
  type EnvelopeShape,
} from './envelope-shape';
export { envelopePresets } from './envelope-presets';
