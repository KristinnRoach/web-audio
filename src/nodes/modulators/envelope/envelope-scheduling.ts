import { cancelAndPinParamValue } from '@/nodes/params/audioparam-utils';

import {
  getDuration,
  type EnvelopeCurve,
  type EnvelopePoint,
  type EnvelopeShape,
} from './envelope-shape';

/** The automation surface an envelope needs; native `AudioParam` is one implementation. */
export type AutomatableParam = {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
};

/**
 * How the envelope reaches the parameter: `param = base + depth * value`.
 *
 * `base` is where the parameter rests when the envelope reads zero, `depth` the distance
 * it moves per unit of shape. Point values are the shape; these two place that shape on whatever range
 * the parameter has, so one envelope drives a gain, a cutoff or a playback rate. A
 * negative `depth` inverts the shape, which is how a filter envelope sweeps downwards.
 *
 * The defaults pass point values through untouched.
 *
 * `timeScale` divides every point time, so values above 1 play the envelope faster.
 * Following a sample's playback rate is this same knob at the call site, not a second
 * mechanism: pass `rate * scale` and the envelope stretches with the sample.
 */
export type ScheduleOptions = {
  base?: number;
  depth?: number;
  timeScale?: number;
};

export function schedulePoint(
  param: AutomatableParam,
  value: number,
  time: number,
  curve: EnvelopeCurve,
) {
  if (curve === 'step') param.setValueAtTime(value, time);
  else if (curve === 'exponential') param.exponentialRampToValueAtTime(value, time);
  else param.linearRampToValueAtTime(value, time);
}

/**
 * The curve a segment can actually ramp with. Web Audio holds an exponential ramp between
 * values of opposite sign at its start value and then jumps, so a segment crossing zero,
 * which a bipolar shape or a negative `depth` can produce, ramps linearly instead.
 */
export function rampCurve(curve: EnvelopeCurve, from: number, to: number): EnvelopeCurve {
  return curve === 'exponential' && haveOppositeSigns(from, to) ? 'linear' : curve;
}

function haveOppositeSigns(a: number, b: number) {
  return a * b < 0;
}

/**
 * An exponential ramp cannot touch zero: a zero target throws, and a zero start silently
 * holds for the whole segment and then jumps, which is a click with no error attached.
 * Both ends of an exponential segment are floored to keep it off zero.
 */
const MIN_EXPONENTIAL_VALUE = 1e-4;

/**
 * The parameter value for a point, held off zero when an exponential segment touches it.
 *
 * The floor is a fraction of `depth`, the span the envelope moves through, so it stays
 * inaudible whatever the parameter is: -80 dB on a unit gain, under a hertz on a cutoff
 * sweep. A parameter resting on a non-zero `base` never reaches zero in the first place
 * and comes through untouched. Only the magnitude is floored, so an inverted envelope
 * keeps its sign rather than jumping across zero, which would degenerate the ramp anyway.
 *
 * `first` and `last` bound the range being scheduled, since only the curves inside it run.
 */
function floorOffZero(value: number, depth: number) {
  // `|| 1` covers a depth of zero, where there is no span to take a fraction of.
  const floor = MIN_EXPONENTIAL_VALUE * (Math.abs(depth) || 1);
  const negative = value < 0 || (value === 0 && depth < 0);

  return (negative ? -1 : 1) * Math.max(Math.abs(value), floor);
}

export function valueOf(
  points: readonly EnvelopePoint[],
  index: number,
  first: number,
  last: number,
  base: number,
  depth: number,
) {
  const value = base + depth * points[index].value;
  const exponential =
    (index > first && points[index - 1].curve === 'exponential') ||
    (index < last && points[index].curve === 'exponential');

  return exponential ? floorOffZero(value, depth) : value;
}

/** Returns the time of the last point scheduled. */
export function scheduleRange(
  param: AutomatableParam,
  envelope: EnvelopeShape,
  from: number,
  to: number,
  startTime: number,
  base: number,
  depth: number,
  timeScale: number,
) {
  const points = envelope.points;
  let previous = valueOf(points, from, from, to, base, depth);
  param.setValueAtTime(previous, startTime);
  let last = startTime;

  for (let index = from + 1; index <= to; index++) {
    last = startTime + getDuration(points, { fromIndex: from, toIndex: index, timeScale });
    const value = valueOf(points, index, from, to, base, depth);
    schedulePoint(
      param,
      value,
      last,
      rampCurve(points[index - 1].curve ?? 'linear', previous, value),
    );
    previous = value;
  }

  return last;
}

/** Schedules through sustain in sustain mode, or through the end otherwise. */
export function scheduleEnvelope(
  param: AutomatableParam,
  envelope: EnvelopeShape,
  startTime: number,
  options: ScheduleOptions = {},
) {
  const { base = 0, depth = 1, timeScale = 1 } = options;
  const { points } = envelope;
  if (points.length === 0) return;

  const end = envelope.mode.type === 'sustain' ? envelope.sustainPoint : points.length - 1;
  scheduleRange(param, envelope, 0, end, startTime, base, depth, timeScale);
}

/**
 * Holds `holdValue` at `releaseTime`, then schedules the points after `releasePoint`
 * at their time differences from `points[releasePoint].time`.
 *
 * ponytail: pins a value rather than calling `cancelAndHoldAtTime`, which Firefox
 * still has not implemented (bugzil.la/1308431). Without `holdValue` it falls back to
 * `param.value`, which is only accurate for now; the player passes the analytic
 * value so a `releaseTime` in the future hands off correctly.
 */
export function releaseEnvelope(
  param: AutomatableParam,
  envelope: EnvelopeShape,
  releaseTime: number,
  options: ScheduleOptions = {},
  holdValue?: number,
) {
  const { base = 0, depth = 1, timeScale = 1 } = options;
  const from = envelope.releasePoint;

  const { points } = envelope;
  const exponentialOut = points[from].curve === 'exponential';

  // An exponential first segment cannot leave zero, so the handoff is floored the same
  // way the point values are. Without a holdValue there is nothing to floor yet.
  const pinned =
    holdValue !== undefined && exponentialOut ? floorOffZero(holdValue, depth) : holdValue;

  cancelAndPinParamValue(param, releaseTime, pinned);

  const last = points.length - 1;
  // Without a holdValue the pinned value is unknown here; the release point stands in for it.
  let previous = pinned ?? valueOf(points, from, from, last, base, depth);
  for (let index = from + 1; index <= last; index++) {
    const value = valueOf(points, index, from, last, base, depth);
    schedulePoint(
      param,
      value,
      releaseTime + getDuration(points, { fromIndex: from, toIndex: index, timeScale }),
      rampCurve(points[index - 1].curve ?? 'linear', previous, value),
    );
    previous = value;
  }
}
