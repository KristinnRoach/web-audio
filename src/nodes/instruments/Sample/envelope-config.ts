import { assertValidEnvelopeShape, type EnvelopeShape } from '../../modulators/envelope';

/** Serializable config shared by editors and envelope players. */
export type EnvelopeConfig = {
  readonly enabled: boolean;
  /** Mix from unmodulated (0) to the full shape (1), default 1. Negative depth inverts the shape. */
  readonly depth?: number;
  /**
   * `[min, max]` the shape's extremes reach at depth 1, in the target's units: gain for amp,
   * cents for pitch and filter, -1..1 for pan. Pitch and pan shapes are bipolar: -1 maps to
   * min, 1 to max, and 0 stays unmodulated. Amp and filter shapes map 0..1 onto min..max.
   * Defaults: amp [0, 1], pitch [-1200, 1200], filter [0, 12000], pan [-1, 1].
   */
  readonly range?: readonly [min: number, max: number];
  /** Timing multiplier; values above 1 play the envelope faster. */
  readonly timeScale: number;
  /** Scales timing by the note's playback rate, so higher notes run the envelope faster. */
  readonly playbackRateSync?: boolean;
  /**
   * Sync a loop-mode envelope to a looping sample, ignoring playbackRateSync.
   * At timeScale 1, a shape spanning the full loaded buffer's duration plays once
   * per sample loop; a half-duration shape plays twice. Restarts at every sample
   * loop boundary, cutting any unfinished pass. Inactive outside loop mode or
   * when the sample loop is off. Otherwise timing uses seconds and playbackRateSync.
   */
  readonly loopSync?: boolean;
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
    ...(config.range && { range: [config.range[0], config.range[1]] }),
  };
}

/** Rejects a config that cannot be scheduled predictably. */
export function assertValidEnvelopeConfig(config: EnvelopeConfig): void {
  if (
    typeof config?.enabled !== 'boolean' ||
    (config.depth !== undefined && !Number.isFinite(config.depth)) ||
    (config.range !== undefined &&
      !(
        Array.isArray(config.range) &&
        config.range.length === 2 &&
        Number.isFinite(config.range[0]) &&
        Number.isFinite(config.range[1]) &&
        config.range[0] <= config.range[1]
      )) ||
    !Number.isFinite(config?.timeScale) ||
    config.timeScale <= 0 ||
    (config.playbackRateSync !== undefined && typeof config.playbackRateSync !== 'boolean') ||
    (config.loopSync !== undefined && typeof config.loopSync !== 'boolean')
  ) {
    throw new TypeError('Invalid envelope settings');
  }

  try {
    assertValidEnvelopeShape(config.shape);
  } catch {
    throw new TypeError('Invalid envelope settings');
  }
}
