import { cancelAndPinParamValue } from '../audioparam-utils';

import {
  releaseEnvelope,
  scheduleEnvelope,
  schedulePoint,
  scheduleRange,
  valueOf,
  type AutomatableParam,
  type ScheduleOptions,
} from './envelope-scheduling';
import {
  assertValidEnvelopeShape,
  getDuration,
  interpolateAtTime,
  type EnvelopeShape,
} from './envelope-shape';

/** The clock surface used to place envelope automation on a timeline. */
export type EnvelopeClock = { readonly currentTime: number };

/**
 * `fromPoint` opens the first pass mid-shape at that point index instead of point 0,
 * for a loop switched on while the envelope is parked on its sustain point: the shape
 * carries on from where it is into its first full cycle rather than snapping back.
 * Looping runs only; every other shape is scheduled in one pass from point 0.
 */
export type EnvelopeTriggerOptions = ScheduleOptions & {
  fromPoint?: number;
  /** Plays this shape for this run only; the stored `shape` is left as it is. */
  shape?: EnvelopeShape;
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

/** Validates and deep-copies a shape, so nobody else's edits reach it. */
function snapshot(shape: EnvelopeShape): EnvelopeShape {
  assertValidEnvelopeShape(shape);
  return {
    ...shape,
    mode: { ...shape.mode },
    points: shape.points.map((point) => ({ ...point })),
  };
}

/**
 * Timestamp-anchored envelope player bound to one param.
 *
 * The envelope owns the param's automation from `trigger` until `stop`: a trigger cancels
 * everything scheduled from its start time on, and automation written by anyone else in
 * that window can be overwritten. Drive other changes through `base` and `amount`, or
 * `stop` the envelope first.
 */
export class Envelope {
  #shape: EnvelopeShape;
  /** The latest run's own copy; `setSustainValue` edits it in place. */
  #envShape: EnvelopeShape | undefined;
  #removeLoop: (() => void) | undefined;
  #triggered = false;
  #base = 0;
  #amount = 1;
  #timeScale = 1;
  #triggerTime = 0;
  #startTime = 0;

  constructor(
    readonly clock: EnvelopeClock,
    readonly param: AutomatableParam,
    shape: EnvelopeShape,
  ) {
    this.#shape = snapshot(shape);
  }

  /**
   * The shape a trigger plays unless it passes its own. Setting it takes effect on the
   * next trigger; a run already on the timeline keeps the copy it started with.
   */
  get shape(): EnvelopeShape {
    return this.#shape;
  }

  set shape(shape: EnvelopeShape) {
    this.#shape = snapshot(shape);
  }

  #stopLoop() {
    this.#removeLoop?.();
    this.#removeLoop = undefined;
  }

  /**
   * How far into the shape the run has got at `time`, in seconds of envelope time. See
   * `position` for why the unit is seconds and not wall seconds.
   *
   * A loop is back at its start every cycle, and a sustained envelope stops advancing
   * once it reaches the sustain point. A one-shot keeps running through its release
   * marker to the end.
   */
  #positionAt(time: number) {
    if (!this.#envShape) return 0;
    const { points, mode, sustainPoint } = this.#envShape;
    if (points.length === 0) return 0;

    let elapsed = Math.max(0, (time - this.#triggerTime) * this.#timeScale);

    if (mode.type === 'loop') {
      // A zero-extent cycle has nowhere to advance to, and `trigger` already declines to
      // loop it. Both read the same duration helper, so they cannot disagree.
      const cycle = getDuration(points);
      elapsed = cycle > 0 ? elapsed % cycle : 0;
    } else if (mode.type === 'sustain') {
      elapsed = Math.min(elapsed, points[sustainPoint].time - points[0].time);
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

  /** Starts a run at `time`, clamped to now: a moment already past cannot be scheduled. */
  trigger(time = this.clock.currentTime, options: EnvelopeTriggerOptions = {}) {
    // Validated before anything changes, so a rejected trigger leaves the live run alone.
    const runEnvelope = snapshot(options.shape ?? this.#shape);
    const timeScale = options.timeScale ?? 1;
    const fullDuration = getDuration(runEnvelope.points, { timeScale });
    time = Math.max(this.clock.currentTime, time);
    this.#envShape = runEnvelope;
    this.#stopLoop();
    this.#triggered = true;
    this.#base = options.base ?? 0;
    this.#amount = options.amount ?? 1;
    this.#timeScale = timeScale;
    this.#triggerTime = time;
    this.#startTime = time;

    // Local aliases for the run's fixed inputs: read once here, and the refill closure
    // below reads the same values rather than whatever a later trigger has set.
    const { param } = this;
    const base = this.#base;
    const amount = this.#amount;

    // Clear only. Every scheduling path below opens with its own setValueAtTime at
    // this same instant, so pinning here would write the param's stale value and be
    // overwritten by the envelope's first point a moment later.
    param.cancelScheduledValues(time);

    const { points } = runEnvelope;
    // A loop repeats the whole envelope. Every other mode schedules one pass;
    // sustain mode stops that pass at the sustain point.
    const loopDuration = runEnvelope.mode.type === 'loop' ? fullDuration : 0;

    if (loopDuration <= 0) {
      scheduleEnvelope(param, runEnvelope, time, { base, amount, timeScale });
      return;
    }

    // Opening mid-shape moves the anchor back to where point 0 would have been, so
    // every cycle boundary below still lands on the same grid and `valueAt` keeps
    // reading the right phase. The anchor is in the past; nothing is scheduled there.
    const from = Math.min(Math.max(options.fromPoint ?? 0, 0), points.length - 1);
    this.#triggerTime = time - getDuration(points, { toIndex: from, timeScale });

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

      while (anchor + (cycle + 1) * loopDuration <= now) cycle++;
      while (anchor + cycle * loopDuration < horizon) {
        // A cycle opens on the same instant the previous one closes, but the two
        // expressions for it can differ by an ULP. When the closing ramp rounds later
        // than the opening setValueAtTime it overwrites the reset and that pass loses
        // its attack, so never open a cycle before the previous one has ended.
        const start = Math.max(anchor + cycle * loopDuration, cycleEnd);
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

  /** Plays the release stage from `time`, clamped to now like `trigger`. */
  release(time = this.clock.currentTime) {
    if (!this.#triggered || !this.#envShape) return;
    time = Math.max(this.clock.currentTime, time);
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

  /** Full duration of the latest run at its time scale; before any run, `shape` at 1. */
  duration() {
    const { points } = this.#envShape ?? this.#shape;
    return getDuration(points, { timeScale: this.#timeScale });
  }

  /** Release-stage duration, read the same way as `duration`. */
  releaseDuration() {
    const { points, releasePoint } = this.#envShape ?? this.#shape;
    return getDuration(points, { fromIndex: releasePoint, timeScale: this.#timeScale });
  }

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
  position(time = this.clock.currentTime) {
    // Argument first, so a bad timestamp is a bug whether or not a run is live.
    if (!Number.isFinite(time)) {
      throw new RangeError('Envelope position time must be a finite number');
    }
    return this.#triggered ? this.#positionAt(time) : null;
  }

  /** Index of the last point reached by a live, non-looping run. */
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
    const { points, mode, sustainPoint } = this.#envShape;
    const last = mode.type === 'sustain' ? sustainPoint : points.length - 1;
    let index = 0;
    while (index < last && points[index + 1].time - points[0].time <= position) index++;
    return index;
  }

  /** Absolute time of the next cycle boundary for a live loop. */
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
   * Moves the held sustain level of the live run toward `value`, around `time`.
   *
   * Best-effort and provisional. Only a sustained run that is live is guaranteed to
   * respond; when the change lands, how it glides and whether an edit before the sustain
   * point is honoured may all change. The stored `shape` is never touched.
   */
  setSustainValue(value: number, time = this.clock.currentTime, glide = 0.02) {
    // Current behaviour, not contract:
    //
    // The one envelope input that is still editable once the run is on the timeline: a
    // sustained run schedules points 0..sustain and stops, so the hold is not an event
    // but the absence of events, and nothing after it has to be rescheduled.
    //
    // The point is mutated in place because `valueAt` and `releaseEnvelope` read the same
    // object; without that the note-off handoff would pin the old value and jump. The
    // player owns that clone, so nobody else sees the write.
    //
    // A run that has not reached its sustain point yet is left alone. Up to that instant
    // the points between here and sustain are still queued, and cancelling to write the new
    // value takes the attack peak with them - the parameter heads straight for the sustain
    // value from wherever it had got to. Rescheduling the remainder from the current
    // position was tried and still stepped audibly. So an earlier call is ignored, not
    // queued: the edit reaches the note only through the caller's stored shape, on the
    // next trigger.
    //
    // The cancel is what makes a fast drag safe: a second ramp ending before the first one
    // would otherwise re-target the old value on the way past.
    //
    // ponytail: releasing mid-glide pins the shape's value, which is the glide's target
    // rather than where it has actually got to, so a note-off inside the glide window can
    // step by up to the edit distance. Inaudible while `glide` stays short. Track the
    // pending glide in `valueAt` if a long one is ever wanted.
    if (!this.#envShape) return;
    const { points, mode, sustainPoint } = this.#envShape;
    if (!this.#triggered || mode.type !== 'sustain') return;
    if (points[sustainPoint].value === value) return;

    const sustainTime =
      this.#triggerTime +
      getDuration(points, { toIndex: sustainPoint, timeScale: this.#timeScale });

    if (time < sustainTime) return;

    // Read the outgoing shape before mutating it, the same ordering release() follows.
    const holdValue = this.#valueAt(time);
    (points[sustainPoint] as { value: number }).value = value;

    cancelAndPinParamValue(this.param, time, holdValue);
    schedulePoint(
      this.param,
      valueOf(points, sustainPoint, 0, sustainPoint, this.#base, this.#amount),
      time + glide,
      'linear',
    );
  }

  /** Ends the run at `time` and pins the param there. The player stays reusable. */
  stop(time = this.clock.currentTime) {
    if (!this.#triggered) return;
    this.#triggered = false;
    this.#stopLoop();
    cancelAndPinParamValue(this.param, time);
  }
}
