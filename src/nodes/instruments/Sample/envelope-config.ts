import { assertValidEnvelopeShape, type EnvelopeShape } from '../../modulators/envelope';

/** Serializable config shared by editors and envelope players. */
export type EnvelopeConfig = {
  readonly enabled: boolean;
  /** Depth multiplier, default 1: gain for amp, 1200 cents for pitch, 12000 cents for filter. */
  readonly depth?: number;
  /** Timing multiplier; values above 1 play the envelope faster. */
  readonly timeScale: number;
  /** Scales timing by the note's playback rate, so higher notes run the envelope faster. */
  readonly playbackRateSync?: boolean;
  /**
   * How a loop-mode envelope is timed against a looping sample.
   * false: durations stay absolute; only the zero-crossing shortfall of the loop is
   * corrected, so an envelope as long as the loop (or a multiple) stays in sync.
   * true: durations are relative to the loop; a sample-length envelope is one loop cycle,
   * whatever the loop points, and it restarts on every sample loop cycle.
   */
  readonly loopRelative?: boolean;
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
    (config.depth !== undefined && !Number.isFinite(config.depth)) ||
    !Number.isFinite(config?.timeScale) ||
    config.timeScale <= 0 ||
    (config.playbackRateSync !== undefined && typeof config.playbackRateSync !== 'boolean') ||
    (config.loopRelative !== undefined && typeof config.loopRelative !== 'boolean')
  ) {
    throw new TypeError('Invalid envelope settings');
  }

  try {
    assertValidEnvelopeShape(config.shape);
  } catch {
    throw new TypeError('Invalid envelope settings');
  }
}
