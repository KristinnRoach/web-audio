import { assertValidEnvelopeShape, type EnvelopeShape } from '../../params/envelopes';

/** Serializable config shared by editors and envelope players. */
export type EnvelopeConfig = {
  readonly enabled: boolean;
  /** Timing multiplier; values above 1 play the envelope faster. */
  readonly timeScale: number;
  /** Scales timing by the note's playback rate, so higher notes run the envelope faster. */
  readonly playbackRateSync?: boolean;
  readonly shape: EnvelopeShape;
};

/** Returns a config snapshot whose shape and points can be safely retained. */
export function cloneEnvelopeConfig(config: EnvelopeConfig): EnvelopeConfig {
  return {
    ...config,
    shape: {
      ...config.shape,
      mode: { ...config.shape.mode },
      points: config.shape.points.map((point) => ({ ...point })),
    },
  };
}

/** Rejects a config that cannot be scheduled predictably. */
export function assertValidEnvelopeConfig(config: EnvelopeConfig): void {
  if (
    typeof config?.enabled !== 'boolean' ||
    !Number.isFinite(config?.timeScale) ||
    config.timeScale <= 0 ||
    (config.playbackRateSync !== undefined && typeof config.playbackRateSync !== 'boolean')
  ) {
    throw new TypeError('Invalid envelope settings');
  }

  try {
    assertValidEnvelopeShape(config.shape);
  } catch {
    throw new TypeError('Invalid envelope settings');
  }
}
