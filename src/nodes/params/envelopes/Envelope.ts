import { cancelAndPinParamValue } from '@/utils';

import {
  assertValidEnvelopeShape,
  baseDuration,
  interpolateAtTime,
  releaseDuration as releaseStageDuration,
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

/** The clock surface used to place envelope automation on a timeline. */
export type EnvelopeClock = { readonly currentTime: number };

/**
 * How the envelope reaches the parameter: `param = base + amount * value`.
 *
 * `base` is where the parameter rests when the envelope reads zero, `amount` the depth
 * it moves by. Point values are the shape; these two place that shape on whatever range
 * the parameter has, so one envelope drives a gain, a cutoff or a playback rate. A
 * negative `amount` inverts the shape, which is how a filter envelope sweeps downwards.
 *
 * The defaults pass point values through untouched.
 *
 * `timeScale` divides every point time, so values above 1 play the envelope faster.
 * Following a sample's playback rate is this same knob at the call site, not a second
 * mechanism: pass `rate * scale` and the envelope stretches with the sample.
 */
export type ScheduleOptions = {
  base?: number;
  amount?: number;
  timeScale?: number;
};

/**
 * `fromPoint` opens the first pass mid-shape at that point index instead of point 0,
 * for a loop switched on while the envelope is parked on its sustain point: the shape
 * carries on from where it is into its first full cycle rather than snapping back.
 * Looping runs only; every other shape is scheduled in one pass from point 0.
 */
export type EnvelopeTriggerOptions = ScheduleOptions & { fromPoint?: number };

export type EnvelopePlayer = {
  trigger(envelope: EnvelopeShape, time?: number, options?: EnvelopeTriggerOptions): void;
  release(time?: number): void;
  /** Full envelope duration using the active run's time scale. */
  duration(): number;
  /** Release-stage duration using the active run's time scale. */
  releaseDuration(): number;
  /**
   * How far into the shape the live run has got at `time`, or `null` when no run is live.
   *
   * **Seconds**, on the same scale `points[i].time` is written in, measured as an offset
   * from `points[0].time`. So `0` is point 0 and `points[2].time` is point 2.
   *
   * Seconds is required, not a convention this module is free to pick: point times reach
   * the parameter as `startTime + (points[i].time - points[from].time) / timeScale`, and
   * that lands in `linearRampToValueAtTime`, which reads `AudioContext` seconds. With
   * `timeScale` dimensionless, point times are seconds and so is this.
   *
   * It is *not* `clock.currentTime - startTime`. Wall seconds are scaled first:
   *
   * ```
   * position = (time - anchorTime) * timeScale
   * ```
   *
   * A `timeScale` of 2 plays the envelope twice as fast, so half a second of wall clock
   * reaches position 1. Reverse it with `anchorTime + position / timeScale` to get back
   * to a context timestamp.
   *
   * The shape then bounds the result, because neither of these runs past its own end:
   * a loop wraps the position into `[0, cycle)`, and a sustained run clamps it at the
   * sustain point's offset and stays there for as long as the note is held.
   *
   * `anchorTime` is where point 0 *would have* been, not necessarily where the run was
   * triggered. A run opened mid-shape with `fromPoint` anchors itself in the past, so its
   * position reads off the same grid as a run that opened at point 0.
   *
   * Null once released or stopped. The release tail runs on its own clock from the
   * note-off instant, so there is no single offset into the shape left to report.
   *
   * Throws `RangeError` on a non-finite `time`, matching how the duration helpers reject
   * one. Null already means "no live run", and overloading it with "you passed garbage"
   * would leave a caller branching on null with no way to tell the two apart.
   */
  position(time?: number): number | null;
  /** Index of the last point reached by a live, non-looping run. */
  currentPoint(time?: number): number | null;
  /** Absolute time of the next cycle boundary for a live loop. */
  nextCycleTime(time?: number): number | null;
  /** Moves the sustain point's value on a run that is holding it; see the implementation. */
  setSustainValue(value: number, time?: number, glide?: number): void;
  stop(time?: number): void;
  dispose(): void;
};

const LOOKAHEAD_SECONDS = 1;
const REFILL_INTERVAL_MS = 50;
const activeLoops = new Set<() => void>();
let refillTimer: ReturnType<typeof setInterval> | undefined;

function addLoop(fill: () => void) {
  activeLoops.add(fill);
  fill();
  refillTimer ??= setInterval(() => activeLoops.forEach((refill) => refill()), REFILL_INTERVAL_MS);

  return () => {
    activeLoops.delete(fill);
    if (activeLoops.size === 0 && refillTimer) {
      clearInterval(refillTimer);
      refillTimer = undefined;
    }
  };
}

function schedulePoint(param: AutomatableParam, value: number, time: number, curve: EnvelopeCurve) {
  if (curve === 'step') param.setValueAtTime(value, time);
  else if (curve === 'exponential') param.exponentialRampToValueAtTime(value, time);
  else param.linearRampToValueAtTime(value, time);
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
 * The floor is a fraction of `amount`, the span the envelope moves through, so it stays
 * inaudible whatever the parameter is: -80 dB on a unit gain, under a hertz on a cutoff
 * sweep. A parameter resting on a non-zero `base` never reaches zero in the first place
 * and comes through untouched. Only the magnitude is floored, so an inverted envelope
 * keeps its sign rather than jumping across zero, which would degenerate the ramp anyway.
 *
 * `first` and `last` bound the range being scheduled, since only the curves inside it run.
 */
function floorOffZero(value: number, amount: number) {
  // `|| 1` covers an amount of zero, where there is no span to take a fraction of.
  const floor = MIN_EXPONENTIAL_VALUE * (Math.abs(amount) || 1);
  const negative = value < 0 || (value === 0 && amount < 0);

  return (negative ? -1 : 1) * Math.max(Math.abs(value), floor);
}

function valueOf(
  points: readonly EnvelopePoint[],
  index: number,
  first: number,
  last: number,
  base: number,
  amount: number,
) {
  const value = base + amount * points[index].value;
  const exponential =
    (index > first && points[index - 1].curve === 'exponential') ||
    (index < last && points[index].curve === 'exponential');

  return exponential ? floorOffZero(value, amount) : value;
}

/** Returns the time of the last point scheduled. */
function scheduleRange(
  param: AutomatableParam,
  envelope: EnvelopeShape,
  from: number,
  to: number,
  startTime: number,
  base: number,
  amount: number,
  timeScale: number,
) {
  const points = envelope.points;
  param.setValueAtTime(valueOf(points, from, from, to, base, amount), startTime);
  let last = startTime;

  for (let index = from + 1; index <= to; index++) {
    last = startTime + (points[index].time - points[from].time) / timeScale;
    schedulePoint(
      param,
      valueOf(points, index, from, to, base, amount),
      last,
      points[index - 1].curve ?? 'linear',
    );
  }

  return last;
}

/** Schedules the envelope up to its sustain point, or to its end when it has none. */
export function scheduleEnvelope(
  param: AutomatableParam,
  envelope: EnvelopeShape,
  startTime: number,
  { base = 0, amount = 1, timeScale = 1 }: ScheduleOptions = {},
) {
  const { points } = envelope;
  if (points.length === 0) return;

  const end = envelope.mode.type === 'sustain' ? envelope.mode.at : points.length - 1;
  scheduleRange(param, envelope, 0, end, startTime, base, amount, timeScale);
}

/**
 * Releases an envelope from `holdValue` through the points after its release index.
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
  { base = 0, amount = 1, timeScale = 1 }: ScheduleOptions = {},
  holdValue?: number,
) {
  const from = envelope.release;

  const { points } = envelope;
  const fromTime = points[from].time;
  const exponentialOut = points[from].curve === 'exponential';

  // An exponential first segment cannot leave zero, so the handoff is floored the same
  // way the point values are. Without a holdValue there is nothing to floor yet.
  const pinned =
    holdValue !== undefined && exponentialOut ? floorOffZero(holdValue, amount) : holdValue;

  cancelAndPinParamValue(param, releaseTime, pinned);

  for (let index = from + 1; index < points.length; index++) {
    schedulePoint(
      param,
      valueOf(points, index, from, points.length - 1, base, amount),
      releaseTime + (points[index].time - fromTime) / timeScale,
      points[index - 1].curve ?? 'linear',
    );
  }
}

/**
 * Timestamp-anchored envelope player.
 *
 * `implements EnvelopePlayer` rather than replacing it: the type stays structural so
 * `observeEnvelopePlayer` can keep returning a plain object as one.
 */
class Envelope implements EnvelopePlayer {
  #envShape: EnvelopeShape | undefined;
  #removeLoop: (() => void) | undefined;
  #disposed = false;
  #triggered = false;
  #base = 0;
  #amount = 1;
  #timeScale = 1;
  #triggerTime = 0;
  #startTime = 0;

  constructor(
    readonly clock: EnvelopeClock,
    readonly param: AutomatableParam,
  ) {}

  #stopLoop() {
    this.#removeLoop?.();
    this.#removeLoop = undefined;
  }

  /**
   * How far into the shape the run has got at `time`, in seconds of envelope time. See
   * `EnvelopePlayer.position` for why the unit is seconds and not wall seconds.
   *
   * A loop is back at its start every cycle, and a sustained envelope stops advancing
   * once it reaches the sustain point. A one-shot keeps running through its release
   * marker to the end.
   */
  #positionAt(time: number) {
    if (!this.#envShape) return 0;
    const { points, mode } = this.#envShape;
    if (points.length === 0) return 0;

    let elapsed = Math.max(0, (time - this.#triggerTime) * this.#timeScale);

    if (mode.type === 'loop') {
      // A zero-extent cycle has nowhere to advance to, and `trigger` already declines to
      // loop it. Both read the same `spanBetween`, so they cannot disagree.
      const cycle = baseDuration(points);
      elapsed = cycle > 0 ? elapsed % cycle : 0;
    } else if (mode.type === 'sustain') {
      elapsed = Math.min(elapsed, points[mode.at].time - points[0].time);
    }

    return elapsed;
  }

  /** The envelope's value at `time`, wherever the shape has got to by then. */
  #valueAt(time: number) {
    if (!this.#envShape) return this.#base;
    const { points } = this.#envShape;
    if (points.length === 0) return this.#base;

    return (
      this.#base + this.#amount * interpolateAtTime(points, points[0].time + this.#positionAt(time))
    );
  }

  trigger(
    sourceEnvelope: EnvelopeShape,
    time = this.clock.currentTime,
    options: EnvelopeTriggerOptions = {},
  ) {
    if (this.#disposed) throw new Error('Cannot trigger a disposed EnvelopePlayer');
    assertValidEnvelopeShape(sourceEnvelope);
    const runEnvelope: EnvelopeShape = {
      ...sourceEnvelope,
      mode: { ...sourceEnvelope.mode },
      points: sourceEnvelope.points.map((point) => ({ ...point })),
    };
    this.#envShape = runEnvelope;
    this.#stopLoop();
    this.#triggered = true;
    this.#base = options.base ?? 0;
    this.#amount = options.amount ?? 1;
    this.#timeScale = options.timeScale ?? 1;
    this.#triggerTime = time;
    this.#startTime = time;

    // Local aliases for the run's fixed inputs: read once here, and the refill closure
    // below reads the same values rather than whatever a later trigger has set.
    const { param } = this;
    const base = this.#base;
    const amount = this.#amount;
    const timeScale = this.#timeScale;

    // Clear only. Every scheduling path below opens with its own setValueAtTime at
    // this same instant, so pinning here would write the param's stale value and be
    // overwritten by the envelope's first point a moment later.
    param.cancelScheduledValues(time);

    const { points } = runEnvelope;
    // A loop repeats the whole envelope. Every other mode schedules one pass;
    // scheduleEnvelope stops that pass at the sustain point when there is one.
    const duration = runEnvelope.mode.type === 'loop' ? baseDuration(points) / timeScale : 0;

    if (duration <= 0) {
      scheduleEnvelope(param, runEnvelope, time, { base, amount, timeScale });
      return;
    }

    // Opening mid-shape moves the anchor back to where point 0 would have been, so
    // every cycle boundary below still lands on the same grid and `valueAt` keeps
    // reading the right phase. The anchor is in the past; nothing is scheduled there.
    const from = Math.min(Math.max(options.fromPoint ?? 0, 0), points.length - 1);
    this.#triggerTime = time - (points[from].time - points[0].time) / timeScale;

    // Cycle n opens at time + n * duration, the first pass included, so there is no
    // pre-loop stage and point 0 lands on the trigger time every pass. Absolute
    // times, not an accumulated sum, so cycles cannot drift apart.
    //
    // Cycle 0 is scheduled here rather than left to the refill below, so a trigger
    // further ahead than the lookahead still has its opening pass queued the moment
    // it is triggered, whatever the refill timer does in between.
    let cycleEnd = scheduleRange(
      param,
      runEnvelope,
      from,
      points.length - 1,
      time,
      base,
      amount,
      timeScale,
    );

    // A partial opening pass ends exactly where cycle 1 begins, so the grid carries on
    // from here either way.
    const anchor = this.#triggerTime;
    let cycle = 1;
    this.#removeLoop = addLoop(() => {
      const now = this.clock.currentTime;
      const horizon = now + LOOKAHEAD_SECONDS;

      while (anchor + (cycle + 1) * duration <= now) cycle++;
      while (anchor + cycle * duration < horizon) {
        // A cycle opens on the same instant the previous one closes, but the two
        // expressions for it can differ by an ULP. When the closing ramp rounds later
        // than the opening setValueAtTime it overwrites the reset and that pass loses
        // its attack, so never open a cycle before the previous one has ended.
        const start = Math.max(anchor + cycle * duration, cycleEnd);
        cycleEnd = scheduleRange(
          param,
          runEnvelope,
          0,
          points.length - 1,
          start,
          base,
          amount,
          timeScale,
        );
        cycle++;
      }
    });
  }

  release(time = this.clock.currentTime) {
    if (!this.#triggered || !this.#envShape) return;
    // Read the shape before anything touches the param, so a future-dated release hands
    // off the value the envelope will actually have reached rather than today's.
    const holdValue = this.#valueAt(time);

    // Deliberately not stop(): its pin would write the param's stale value at exactly
    // the instant releaseEnvelope pins the right one. The second cancel drops the first
    // write so the timeline ends up correct either way, but only one of them is true.
    this.#triggered = false;
    this.#stopLoop();

    releaseEnvelope(
      this.param,
      this.#envShape,
      time,
      { base: this.#base, amount: this.#amount, timeScale: this.#timeScale },
      holdValue,
    );
  }

  duration() {
    if (!this.#envShape) return 0;
    return baseDuration(this.#envShape.points) / this.#timeScale;
  }

  releaseDuration() {
    if (!this.#envShape) return 0;
    const { points, release } = this.#envShape;
    return releaseStageDuration(points, release, this.#timeScale);
  }

  position(time = this.clock.currentTime) {
    // Argument first, so a bad timestamp is a bug whether or not a run is live.
    if (!Number.isFinite(time)) {
      throw new RangeError('Envelope position time must be a finite number');
    }
    return this.#triggered ? this.#positionAt(time) : null;
  }

  currentPoint(time = this.clock.currentTime) {
    if (
      !this.#triggered ||
      !this.#envShape ||
      this.#envShape.mode.type === 'loop' ||
      this.#envShape.points.length === 0
    ) {
      return null;
    }

    const position = this.#positionAt(time);
    const { points, mode } = this.#envShape;
    const last = mode.type === 'sustain' ? mode.at : points.length - 1;
    let index = 0;
    while (index < last && points[index + 1].time - points[0].time <= position) index++;
    return index;
  }

  nextCycleTime(time = this.clock.currentTime) {
    if (!this.#triggered || !this.#envShape || this.#envShape.mode.type !== 'loop') return null;
    const cycle = this.duration();
    if (cycle <= 0) return null;

    // A pickup backdates the phase anchor, but no automation starts before startTime.
    if (time < this.#startTime) return this.#startTime;
    const elapsed = time - this.#triggerTime;
    return this.#triggerTime + (Math.floor(elapsed / cycle) + 1) * cycle;
  }

  /**
   * Moves the sustain point's value mid-note.
   *
   * The one envelope input that is still editable once the run is on the timeline: a
   * sustained run schedules points 0..sustain and stops, so the hold is not an event
   * but the absence of events, and nothing after it has to be rescheduled.
   *
   * The point is mutated in place because `valueAt` and `releaseEnvelope` read the same
   * object; without that the note-off handoff would pin the old value and jump. The
   * player owns that clone, so nobody else sees the write.
   *
   * A run that has not reached its sustain point yet is left alone. Up to that instant
   * the points between here and sustain are still queued, and cancelling to write the new
   * value takes the attack peak with them - the parameter heads straight for the sustain
   * value from wherever it had got to. Those edits wait for the next trigger, like every
   * other envelope edit. Rescheduling the remainder would lift that restriction.
   *
   * The cancel is what makes a fast drag safe: a second ramp ending before the first one
   * would otherwise re-target the old value on the way past.
   *
   * ponytail: releasing mid-glide pins the shape's value, which is the glide's target
   * rather than where it has actually got to, so a note-off inside the glide window can
   * step by up to the edit distance. Inaudible while `glide` stays short. Track the
   * pending glide in `valueAt` if a long one is ever wanted.
   */
  setSustainValue(value: number, time = this.clock.currentTime, glide = 0.02) {
    if (!this.#envShape) return;
    const { points, mode } = this.#envShape;
    if (!this.#triggered || mode.type !== 'sustain') return;
    const sustain = mode.at;
    if (points[sustain].value === value) return;

    const sustainTime =
      this.#triggerTime + (points[sustain].time - points[0].time) / this.#timeScale;

    if (time < sustainTime) return;

    // Read the outgoing shape before mutating it, the same ordering release() follows.
    const holdValue = this.#valueAt(time);
    (points[sustain] as { value: number }).value = value;

    cancelAndPinParamValue(this.param, time, holdValue);
    schedulePoint(
      this.param,
      valueOf(points, sustain, 0, sustain, this.#base, this.#amount),
      time + glide,
      'linear',
    );
  }

  stop(time = this.clock.currentTime) {
    if (!this.#triggered) return;
    this.#triggered = false;
    this.#stopLoop();
    cancelAndPinParamValue(this.param, time);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
  }
}

/** Creates a timestamp-anchored envelope player. */
export function createEnvelope(clock: EnvelopeClock, param: AutomatableParam): EnvelopePlayer {
  return new Envelope(clock, param);
}
