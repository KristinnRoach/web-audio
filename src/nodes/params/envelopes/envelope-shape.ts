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
const lastIndex = (points: readonly EnvelopePoint[]) => points.length - 1;

/**
 * Unscaled seconds between two points, or 0 when the range is empty or out of bounds.
 *
 * The single expression for "how long is this stretch of the shape". Every duration in
 * the module goes through here, including the player's, so a loop's cycle length and the
 * grid its cycles are placed on cannot round differently and walk apart.
 */
export function spanBetween(
  points: readonly EnvelopePoint[],
  fromIndex: number,
  toIndex: number,
): number {
  if (fromIndex < 0 || toIndex > lastIndex(points) || fromIndex >= toIndex) return 0;
  return points[toIndex].time - points[fromIndex].time;
}

export function baseDuration(points: readonly EnvelopePoint[]): number {
  return spanBetween(points, 0, lastIndex(points));
}

/**
 * `spanBetween` divided by `timeScale`, which is dimensionless, so values above 1 shorten
 * the result. A non-finite or non-positive scale is ignored rather than throwing, since
 * these are display-side queries.
 *
 * Callers holding a stored scale and a per-run multiplier compose the two themselves;
 * there is no second multiplier parameter here.
 */
export function scaledDuration(
  points: readonly EnvelopePoint[],
  fromIndex: number,
  toIndex: number,
  timeScale = 1,
): number {
  const duration = spanBetween(points, fromIndex, toIndex);
  return Number.isFinite(timeScale) && timeScale > 0 ? duration / timeScale : duration;
}

/** Offset from point 0 to the point the release stage starts from. */
export function releaseStartTime(
  points: readonly EnvelopePoint[],
  release: number,
  timeScale = 1,
): number {
  return scaledDuration(points, 0, release, timeScale);
}

/** Duration of the release stage: the release point through to the last point. */
export function releaseDuration(
  points: readonly EnvelopePoint[],
  release: number,
  timeScale = 1,
): number {
  return scaledDuration(points, release, lastIndex(points), timeScale);
}

export function hasVariation(points: readonly EnvelopePoint[]): boolean {
  const first = points[0]?.value ?? 0;
  return points.some((point) => Math.abs(point.value - first) > 0.001);
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
  if (
    points.length >= 2 &&
    (time < points[0].time || time > points[lastIndex(envelope.points)].time)
  ) {
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

/** Points only: moving a point cannot shift the sustain or release markers. */
export function updatePoint(
  points: readonly EnvelopePoint[],
  index: number,
  time?: number,
  value?: number,
): readonly EnvelopePoint[] {
  if (index < 0 || index >= points.length) return points;

  const current = points[index];
  const nextTime = time ?? current.time;
  if (!Number.isFinite(nextTime)) return points;
  const before = points[index - 1];
  const after = points[index + 1];
  if ((before && nextTime <= before.time) || (after && nextTime >= after.time)) return points;

  const next = clonePoints(points);
  next[index] = { ...current, time: nextTime, value: value ?? current.value };
  return next;
}

export function deletePoint(envelope: EnvelopeShape, index: number): EnvelopeShape {
  const { points } = envelope;
  if (points.length <= 2 || index <= 0 || index >= lastIndex(envelope.points)) return envelope;

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

/** Points only: scaling every time proportionally leaves the marker indices valid. */
export function setDuration(
  points: readonly EnvelopePoint[],
  seconds: number,
): readonly EnvelopePoint[] {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError('Envelope duration must be greater than zero');
  }

  if (points.length < 2) return points;

  const start = points[0].time;
  const current = baseDuration(points);
  return points.map((point, index) => ({
    ...point,
    time:
      current > 0
        ? start + (point.time - start) * (seconds / current)
        : index === lastIndex(points)
          ? start + seconds
          : point.time,
  }));
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
