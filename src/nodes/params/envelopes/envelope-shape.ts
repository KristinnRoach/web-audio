import type { EnvelopePoint, EnvelopeState, PointEnvelopeShape } from "./env-types";

/**
 * Editing and measuring an envelope shape.
 *
 * Every function returns a new shape rather than mutating one. A shape is plain data
 * inside `EnvelopeState`, which is the single representation the library stores, sends
 * over the message bus and hands to `bindEnvelope`. Keeping the edits as functions is
 * what lets one owner hold that state while anything else derives from it.
 *
 * Point times are absolute seconds and assumed sorted. The scheduler never re-sorts
 * them, so an edit that would cross two points is refused here instead.
 */

const clone = (points: readonly EnvelopePoint[]) => points.map((point) => ({ ...point }));

/** First and last points anchor the shape; only the interior can be added to or removed. */
const lastIndex = (shape: PointEnvelopeShape) => shape.points.length - 1;

export function baseDuration(shape: PointEnvelopeShape): number {
  const points = shape.points;
  return points.length ? points[lastIndex(shape)].time - points[0].time : 0;
}

/**
 * How long a span of the envelope actually takes, once time scaling is applied.
 *
 * `playbackRate` only counts when the state asks to follow it, which is the same rule
 * `bindEnvelope` applies. Both read it off the state so they cannot drift apart.
 */
export function scaledDuration(
  state: EnvelopeState,
  fromIndex: number,
  toIndex: number,
  playbackRate = 1,
): number {
  const { points } = state.shape;
  if (fromIndex < 0 || toIndex > lastIndex(state.shape) || fromIndex >= toIndex) return 0;

  const raw = points[toIndex].time - points[fromIndex].time;
  const scale = state.timeScale * (state.playbackRateSync ? playbackRate : 1);

  return Number.isFinite(scale) && scale > 0 ? raw / scale : raw;
}

/** When the release stage begins, measured from the trigger. */
export function releaseStartTime(state: EnvelopeState, playbackRate = 1): number {
  return scaledDuration(state, 0, state.shape.releaseIndex, playbackRate);
}

/** How long the release tail runs for, which is what a voice waits out before freeing. */
export function releaseDuration(state: EnvelopeState, playbackRate = 1): number {
  return scaledDuration(state, state.shape.releaseIndex, lastIndex(state.shape), playbackRate);
}

/** Whether the shape actually moves, or is a flat line that is not worth scheduling. */
export function hasVariation(shape: PointEnvelopeShape): boolean {
  const first = shape.points[0]?.value ?? 0;
  return shape.points.some((point) => Math.abs(point.value - first) > 0.001);
}

/**
 * Inserts a point, keeping the shape sorted and the marked indices on the same points.
 *
 * A point outside the existing span is refused: the first and last points anchor the
 * envelope, and moving either by a side effect of an insert is never what was meant.
 */
export function addPoint(
  shape: PointEnvelopeShape,
  time: number,
  value: number,
  curve: EnvelopePoint["curve"] = "exponential",
): PointEnvelopeShape {
  const points = shape.points;
  if (points.length >= 2 && (time < points[0].time || time > points[lastIndex(shape)].time)) {
    return shape;
  }

  const at = points.findIndex((point) => point.time > time);
  const insertAt = at === -1 ? points.length : at;
  const next = clone(points);
  next.splice(insertAt, 0, { time, value, curve });

  return {
    ...shape,
    points: next,
    // A point inserted at or before a marked index pushes that marker along with it, so
    // sustain and release stay on the points they were put on.
    sustainIndex:
      shape.sustainIndex !== null && insertAt <= shape.sustainIndex
        ? shape.sustainIndex + 1
        : shape.sustainIndex,
    releaseIndex: insertAt <= shape.releaseIndex ? shape.releaseIndex + 1 : shape.releaseIndex,
  };
}

/**
 * Moves a point in time or value.
 *
 * A move that would cross a neighbour is refused, since the scheduler walks the points
 * in order and never re-sorts them. The old data layer only guarded the two points
 * either side of the anchors, which left an interior point free to be dragged past its
 * neighbour and silently break the shape.
 */
export function updatePoint(
  shape: PointEnvelopeShape,
  index: number,
  time?: number,
  value?: number,
): PointEnvelopeShape {
  const points = shape.points;
  if (index < 0 || index >= points.length) return shape;

  const current = points[index];
  const nextTime = time ?? current.time;

  const before = points[index - 1];
  const after = points[index + 1];
  if ((before && nextTime <= before.time) || (after && nextTime >= after.time)) return shape;

  const next = clone(points);
  next[index] = { ...current, time: nextTime, value: value ?? current.value };

  return { ...shape, points: next };
}

/**
 * Removes an interior point, pulling the marked indices back with it.
 *
 * A release marker sitting on the removed point moves to the next point along, or back
 * to the one before the end when there is no next point, so there is always a release
 * stage to play.
 */
export function deletePoint(shape: PointEnvelopeShape, index: number): PointEnvelopeShape {
  const points = shape.points;
  if (points.length <= 2 || index <= 0 || index >= lastIndex(shape)) return shape;

  const next = clone(points);
  next.splice(index, 1);
  const end = next.length - 1;

  const sustainIndex =
    shape.sustainIndex === null
      ? null
      : shape.sustainIndex === index
        ? null
        : shape.sustainIndex > index
          ? shape.sustainIndex - 1
          : shape.sustainIndex;

  const releaseIndex =
    shape.releaseIndex > index
      ? shape.releaseIndex - 1
      : shape.releaseIndex === index
        ? Math.min(shape.releaseIndex, Math.max(0, end - 1))
        : shape.releaseIndex;

  return { ...shape, points: next, sustainIndex, releaseIndex };
}

/** Stretches or squeezes the whole shape to a new duration, anchored on the first point. */
export function setDuration(shape: PointEnvelopeShape, seconds: number): PointEnvelopeShape {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError("Envelope duration must be greater than zero");
  }

  const points = shape.points;
  if (points.length < 2) return shape;

  const start = points[0].time;
  const current = baseDuration(shape);

  const next =
    current > 0
      ? points.map((point) => ({
          ...point,
          time: start + (point.time - start) * (seconds / current),
        }))
      : points.map((point, index) =>
          index === lastIndex(shape) ? { ...point, time: start + seconds } : { ...point },
        );

  return { ...shape, points: next };
}

/** Held until release, or null to play straight through. Out-of-range indices are ignored. */
export function setSustainPoint(
  shape: PointEnvelopeShape,
  index: number | null,
): PointEnvelopeShape {
  if (index === null) return { ...shape, sustainIndex: null };
  if (index < 0 || index >= shape.points.length) return shape;
  return { ...shape, sustainIndex: index };
}

/** Where the release stage starts. Out-of-range indices are ignored. */
export function setReleasePoint(shape: PointEnvelopeShape, index: number): PointEnvelopeShape {
  if (index < 0 || index >= shape.points.length) return shape;
  return { ...shape, releaseIndex: index };
}
