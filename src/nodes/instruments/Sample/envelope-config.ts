import { assertValidEnvelopeShape, type EnvelopeShape } from '../../params/envelopes';

/** Serializable config shared by editors and envelope players. */
export type EnvelopeConfig = {
  readonly enabled: boolean;
  /** Timing multiplier; values above 1 play the envelope faster. */
  readonly timeScale: number;
  readonly envelope: EnvelopeShape;
};

/** Returns a config snapshot whose shape and points can be safely retained. */
export function cloneEnvelopeConfig(config: EnvelopeConfig): EnvelopeConfig {
  return {
    ...config,
    envelope: {
      ...config.envelope,
      mode: { ...config.envelope.mode },
      points: config.envelope.points.map((point) => ({ ...point })),
    },
  };
}

/** Rejects a config that cannot be scheduled predictably. */
export function assertValidEnvelopeConfig(config: EnvelopeConfig): void {
  if (
    typeof config?.enabled !== 'boolean' ||
    !Number.isFinite(config?.timeScale) ||
    config.timeScale <= 0
  ) {
    throw new TypeError('Invalid envelope settings');
  }

  try {
    assertValidEnvelopeShape(config.envelope);
  } catch {
    throw new TypeError('Invalid envelope settings');
  }
}
