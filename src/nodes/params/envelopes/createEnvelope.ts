// createEnvelope.ts
import { CustomEnvelope } from './CustomEnvelope';
import type { EnvelopeType, EnvelopePoint } from './env-types';
import type { EnvelopeData } from './EnvelopeData';

interface EnvelopeOptions {
  durationSeconds?: number;
  points?: EnvelopePoint[];
  envPointValueRange?: [number, number];
  initEnable?: boolean;
  sharedData?: EnvelopeData;
  sustainPointIndex?: number | null;
  releasePointIndex?: number;
}

export function createEnvelope(
  context: AudioContext,
  type: EnvelopeType,
  options: EnvelopeOptions = {}
): CustomEnvelope {
  const {
    durationSeconds = 2,
    points,
    sustainPointIndex,
    releasePointIndex,
    envPointValueRange,
    initEnable,
    sharedData,
  } = options;

  // Use shared data if provided // todo: finish or remove
  if (sharedData) {
    return new CustomEnvelope(context, type, sharedData);
  }

  const defaults = CustomEnvelope.getDefaults(type, durationSeconds);

  // Use custom values or defaults
  const finalPoints = points || defaults.points;
  let finalValueRange = envPointValueRange || defaults.envPointValueRange;
  const finalInitEnable =
    initEnable !== undefined ? initEnable : defaults.initEnable;
  const finalSustainIndex =
    sustainPointIndex !== undefined
      ? sustainPointIndex
      : defaults.sustainPointIndex;
  const finalReleaseIndex =
    releasePointIndex !== undefined
      ? releasePointIndex
      : defaults.releasePointIndex;

  const envelope = new CustomEnvelope(
    context,
    type,
    undefined, // no shared data
    finalPoints,
    finalValueRange,
    durationSeconds,
    finalInitEnable
  ); // Set sustain and release points
  envelope.setSustainPoint(finalSustainIndex);
  finalReleaseIndex && envelope.setReleasePoint(finalReleaseIndex);

  return envelope;
}
