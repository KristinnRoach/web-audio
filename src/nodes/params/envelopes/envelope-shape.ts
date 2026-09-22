export type EnvelopeCurve = 'step' | 'linear' | 'exponential';

export type EnvelopePoint = {
  readonly time: number;
  readonly value: number;
  /** Curve from this point to the next one. Defaults to linear. */
  readonly curve?: EnvelopeCurve;
};

export type EnvelopeMode =
  /** Play through once. */
  | { readonly type: 'once' }
  /** Hold `at`'s value until release. */
  | { readonly type: 'sustain'; readonly at: number }
  /** Repeat the whole envelope until release. */
  | { readonly type: 'loop' };

/**
 * Three shapes: play through once, hold at a point until release, or loop until release.
 * A loop repeats the whole envelope, so it and `sustain` are alternatives, not a pair.
 */
export type EnvelopeShape = {
  /**
   * Times are offsets from `points[0].time`, so point 0 lands on the trigger time
   * whatever that value is. A delay before the attack is a second point at the same
   * value, not a non-zero first time.
   *
   * Assumed sorted by time. Nothing re-sorts them on the audio path.
   */
  readonly points: readonly EnvelopePoint[];
  /** How the envelope advances until it is released. */
  readonly mode: EnvelopeMode;
  /**
   * Point the release stage starts from. Presets normally use the second-last point.
   *
   * This is an alternate exit path used when `release()` interrupts playback; it does
   * not mark the end of a loop. A loop repeats the whole envelope.
   */
  readonly release: number;
};

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

/** Rejects an envelope that cannot be scheduled predictably. */
export function assertValidEnvelopeShape(envelope: EnvelopeShape): void {
  const points = envelope?.points;
  const validMarker = (index: number) =>
    Number.isInteger(index) && Array.isArray(points) && index >= 0 && index < points.length;
  const mode = envelope?.mode;
  const validMode =
    mode?.type === 'once' ||
    mode?.type === 'loop' ||
    (mode?.type === 'sustain' && validMarker(mode.at));

  if (
    !Array.isArray(points) ||
    points.length < 2 ||
    !validMode ||
    points.some(
      (point, index) =>
        !Number.isFinite(point.time) ||
        !Number.isFinite(point.value) ||
        (point.curve !== undefined &&
          point.curve !== 'step' &&
          point.curve !== 'linear' &&
          point.curve !== 'exponential') ||
        (index > 0 && point.time < points[index - 1].time),
    ) ||
    !validMarker(envelope.release)
  ) {
    throw new TypeError('Invalid envelope');
  }
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

/**
 * The envelope's own value at a point in envelope time, following each segment's curve.
 *
 * Reading `param.value` only ever answers for now, so it cannot say where a release
 * scheduled in the future should start from. The shape can.
 */
export function interpolateAtTime(points: readonly EnvelopePoint[], time: number): number {
  const last = points.length - 1;
  if (last < 0) return 0;
  if (time <= points[0].time) return points[0].value;
  if (time >= points[last].time) return points[last].value;

  let i = 0;
  while (i < last && points[i + 1].time <= time) i++;

  const left = points[i];
  const right = points[i + 1];
  const span = right.time - left.time;
  if (span <= 0) return right.value;

  if (left.curve === 'step') return left.value;

  const t = (time - left.time) / span;
  if (left.curve === 'exponential' && left.value > 0 && right.value > 0) {
    return left.value * Math.pow(right.value / left.value, t);
  }
  return left.value + (right.value - left.value) * t;
}

const clonePoints = (points: readonly EnvelopePoint[]) => points.map((point) => ({ ...point }));
const lastIndex = (envelope: EnvelopeShape) => envelope.points.length - 1;

/**
 * Unscaled seconds between two points, or 0 when the range is empty or out of bounds.
 *
 * The single expression for "how long is this stretch of the shape". Every duration in
 * the module goes through here, including the player's, so a loop's cycle length and the
 * grid its cycles are placed on cannot round differently and walk apart.
 */
export function spanBetween(envelope: EnvelopeShape, fromIndex: number, toIndex: number): number {
  const { points } = envelope;
  if (fromIndex < 0 || toIndex > lastIndex(envelope) || fromIndex >= toIndex) return 0;
  return points[toIndex].time - points[fromIndex].time;
}

export function baseDuration(envelope: EnvelopeShape): number {
  return spanBetween(envelope, 0, lastIndex(envelope));
}

export function scaledDuration(
  config: EnvelopeConfig,
  fromIndex: number,
  toIndex: number,
  timeScaleMultiplier = 1,
): number {
  const duration = spanBetween(config.envelope, fromIndex, toIndex);
  const scale = config.timeScale * timeScaleMultiplier;
  return Number.isFinite(scale) && scale > 0 ? duration / scale : duration;
}

export function releaseStartTime(config: EnvelopeConfig, timeScaleMultiplier = 1): number {
  return scaledDuration(config, 0, config.envelope.release, timeScaleMultiplier);
}

export function releaseDuration(config: EnvelopeConfig, timeScaleMultiplier = 1): number {
  return scaledDuration(
    config,
    config.envelope.release,
    lastIndex(config.envelope),
    timeScaleMultiplier,
  );
}

export function hasVariation(envelope: EnvelopeShape): boolean {
  const first = envelope.points[0]?.value ?? 0;
  return envelope.points.some((point) => Math.abs(point.value - first) > 0.001);
}

export function addPoint(
  envelope: EnvelopeShape,
  time: number,
  value: number,
  curve: EnvelopePoint['curve'] = 'exponential',
): EnvelopeShape {
  const { points } = envelope;
  if (!Number.isFinite(time)) return envelope;
  if (points.some((point) => point.time === time)) return envelope;
  if (points.length >= 2 && (time < points[0].time || time > points[lastIndex(envelope)].time)) {
    return envelope;
  }

  const at = points.findIndex((point) => point.time > time);
  const insertAt = at === -1 ? points.length : at;
  const next = clonePoints(points);
  next.splice(insertAt, 0, { time, value, curve });

  return {
    ...envelope,
    points: next,
    mode:
      envelope.mode.type === 'sustain' && insertAt <= envelope.mode.at
        ? { ...envelope.mode, at: envelope.mode.at + 1 }
        : envelope.mode,
    release: insertAt <= envelope.release ? envelope.release + 1 : envelope.release,
  };
}

export function updatePoint(
  envelope: EnvelopeShape,
  index: number,
  time?: number,
  value?: number,
): EnvelopeShape {
  const { points } = envelope;
  if (index < 0 || index >= points.length) return envelope;

  const current = points[index];
  const nextTime = time ?? current.time;
  if (!Number.isFinite(nextTime)) return envelope;
  const before = points[index - 1];
  const after = points[index + 1];
  if ((before && nextTime <= before.time) || (after && nextTime >= after.time)) return envelope;

  const next = clonePoints(points);
  next[index] = { ...current, time: nextTime, value: value ?? current.value };
  return { ...envelope, points: next };
}

export function deletePoint(envelope: EnvelopeShape, index: number): EnvelopeShape {
  const { points } = envelope;
  if (points.length <= 2 || index <= 0 || index >= lastIndex(envelope)) return envelope;

  const next = clonePoints(points);
  next.splice(index, 1);
  const end = next.length - 1;
  const release = envelope.release > index ? envelope.release - 1 : envelope.release;
  const mode =
    envelope.mode.type !== 'sustain'
      ? envelope.mode
      : envelope.mode.at === index
        ? { type: 'once' as const }
        : {
            ...envelope.mode,
            at: envelope.mode.at > index ? envelope.mode.at - 1 : envelope.mode.at,
          };

  return {
    ...envelope,
    points: next,
    mode,
    release: envelope.release === index ? Math.min(index, Math.max(0, end - 1)) : release,
  };
}

export function setDuration(envelope: EnvelopeShape, seconds: number): EnvelopeShape {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError('Envelope duration must be greater than zero');
  }

  const { points } = envelope;
  if (points.length < 2) return envelope;

  const start = points[0].time;
  const current = baseDuration(envelope);
  const next = points.map((point, index) => ({
    ...point,
    time:
      current > 0
        ? start + (point.time - start) * (seconds / current)
        : index === points.length - 1
          ? start + seconds
          : point.time,
  }));

  return { ...envelope, points: next };
}

export function setSustainPoint(envelope: EnvelopeShape, index?: number): EnvelopeShape {
  if (index !== undefined && (index < 0 || index >= envelope.points.length)) return envelope;
  return {
    ...envelope,
    mode: index === undefined ? { type: 'once' } : { type: 'sustain', at: index },
  };
}

export function setReleasePoint(envelope: EnvelopeShape, index: number): EnvelopeShape {
  if (index < 0 || index >= envelope.points.length) return envelope;
  return { ...envelope, release: index };
}
