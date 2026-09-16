import { cancelAndPinParamValue } from "@/utils";

export type EnvelopeCurve = "step" | "linear" | "exponential";

/** The automation surface an envelope needs; native `AudioParam` is one implementation. */
export type AutomatableParam = {
  value: number;
  readonly minValue: number;
  readonly maxValue: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
};

export type EnvelopePoint = {
  readonly time: number;
  readonly value: number;
  /** Curve from this point to the next one. Defaults to linear. */
  readonly curve?: EnvelopeCurve;
};

export type PlaybackMode =
  /** One-shot. Default. */
  | { readonly type: "once" }
  /** Hold `at`'s value until release. */
  | { readonly type: "sustain"; readonly at: number }
  /** Repeat the full duration. */
  | { readonly type: "loop" };

/**
 * Three shapes: play through once, hold at a point until release, or loop until release.
 * A loop repeats the whole envelope, so it and `sustain` are alternatives, not a pair.
 */
export type Envelope = {
  /**
   * Times are offsets from `points[0].time`, so point 0 lands on the trigger time
   * whatever that value is. A delay before the attack is a second point at the same
   * value, not a non-zero first time.
   *
   * Assumed sorted by time. Nothing re-sorts them on the audio path.
   */
  readonly points: readonly EnvelopePoint[];
  /**
   * Point the release stage starts from. Defaults to `sustain`, and without either
   * there is no release stage and `release()` does nothing.
   *
   * Set it without a `sustain` for a shape that plays through on its own while the
   * note is held and still has a tail to jump to on note-off. That is how a sampler
   * amp envelope decays on its own yet still has a release, and it is the one thing
   * a lone `sustain` cannot express: `sustain` holds where this one keeps moving.
   */
  readonly release?: number;
  /** Point held until release. Points after it form the release stage. */
  readonly sustain?: number;
  /**
   * Repeats the whole envelope while the note is held. Takes the place of `sustain`
   * rather than combining with it.
   */
  readonly loop?: boolean;
};

/** Serializable settings shared by editors and schedulers. */
export type EnvelopeSettings = {
  readonly enabled: boolean;
  /** Timing multiplier; values above 1 play the envelope faster. */
  readonly timeScale: number;
  readonly envelope: Envelope;
};

/** Returns a settings snapshot whose shape and points can be safely retained. */
export function cloneEnvelopeSettings(settings: EnvelopeSettings): EnvelopeSettings {
  return {
    ...settings,
    envelope: {
      ...settings.envelope,
      points: settings.envelope.points.map((point) => ({ ...point })),
    },
  };
}

/** Rejects settings that cannot be scheduled predictably. */
export function assertValidEnvelopeSettings(settings: EnvelopeSettings): void {
  const points = settings?.envelope?.points;
  const validMarker = (index: number | undefined) =>
    index === undefined ||
    (Number.isInteger(index) && Array.isArray(points) && index >= 0 && index < points.length);

  if (
    typeof settings?.enabled !== "boolean" ||
    !Number.isFinite(settings?.timeScale) ||
    settings.timeScale <= 0 ||
    !Array.isArray(points) ||
    points.length < 2 ||
    (settings.envelope.loop !== undefined && typeof settings.envelope.loop !== "boolean") ||
    points.some(
      (point, index) =>
        !Number.isFinite(point.time) ||
        !Number.isFinite(point.value) ||
        (point.curve !== undefined &&
          point.curve !== "step" &&
          point.curve !== "linear" &&
          point.curve !== "exponential") ||
        (index > 0 && point.time < points[index - 1].time),
    ) ||
    !validMarker(settings.envelope.sustain) ||
    !validMarker(settings.envelope.release)
  ) {
    throw new TypeError("Invalid envelope settings");
  }
}

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
export type ScheduleOptions = { base?: number; amount?: number; timeScale?: number };

export type EnvelopeScheduler = {
  trigger(time?: number, options?: ScheduleOptions): void;
  release(time?: number): void;
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
  if (curve === "step") param.setValueAtTime(value, time);
  else if (curve === "exponential") param.exponentialRampToValueAtTime(value, time);
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
    (index > first && points[index - 1].curve === "exponential") ||
    (index < last && points[index].curve === "exponential");

  return exponential ? floorOffZero(value, amount) : value;
}

/** Returns the time of the last point scheduled. */
function scheduleRange(
  param: AutomatableParam,
  envelope: Envelope,
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
      points[index - 1].curve ?? "linear",
    );
  }

  return last;
}

/** Schedules the envelope up to its sustain point, or to its end when it has none. */
export function scheduleEnvelope(
  param: AutomatableParam,
  envelope: Envelope,
  startTime: number,
  { base = 0, amount = 1, timeScale = 1 }: ScheduleOptions = {},
) {
  const { points } = envelope;
  if (points.length === 0) return;

  const end = envelope.sustain ?? points.length - 1;
  scheduleRange(param, envelope, 0, end, startTime, base, amount, timeScale);
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

  if (left.curve === "step") return left.value;

  const t = (time - left.time) / span;
  if (left.curve === "exponential" && left.value > 0 && right.value > 0) {
    return left.value * Math.pow(right.value / left.value, t);
  }
  return left.value + (right.value - left.value) * t;
}

/** Where the release stage starts: `release` if given, else `sustain`, else nowhere. */
function releaseIndexOf(envelope: Envelope) {
  const index = envelope.release ?? envelope.sustain;
  return index !== undefined && envelope.points[index] ? index : undefined;
}

/**
 * Releases an envelope from `holdValue` through the points after its release index.
 *
 * ponytail: pins a value rather than calling `cancelAndHoldAtTime`, which Firefox
 * still has not implemented (bugzil.la/1308431). Without `holdValue` it falls back to
 * `param.value`, which is only accurate for now; the scheduler passes the analytic
 * value so a `releaseTime` in the future hands off correctly.
 */
export function releaseEnvelope(
  param: AutomatableParam,
  envelope: Envelope,
  releaseTime: number,
  { base = 0, amount = 1, timeScale = 1 }: ScheduleOptions = {},
  holdValue?: number,
) {
  const from = releaseIndexOf(envelope);
  if (from === undefined) return;

  const { points } = envelope;
  const fromTime = points[from].time;
  const exponentialOut = points[from].curve === "exponential";

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
      points[index - 1].curve ?? "linear",
    );
  }
}

/** Creates a timestamp-anchored rolling scheduler for an envelope. */
export function createEnvelopeScheduler(
  context: AudioContext,
  param: AutomatableParam,
  envelope: Envelope,
): EnvelopeScheduler {
  let removeLoop: (() => void) | undefined;
  let triggered = false;
  let base = 0;
  let amount = 1;
  let timeScale = 1;
  let triggerTime = 0;

  const stopLoop = () => {
    removeLoop?.();
    removeLoop = undefined;
  };

  /**
   * The envelope's value at `time`, wherever the shape has got to by then.
   *
   * A loop is back at its start every cycle, and a sustained envelope stops advancing
   * once it reaches the sustain point. Everything else keeps running, which is what a
   * release index without a sustain is for.
   */
  const valueAt = (time: number) => {
    const { points, sustain } = envelope;
    if (points.length === 0) return base;

    let elapsed = Math.max(0, (time - triggerTime) * timeScale);

    if (envelope.loop) {
      const cycle = points[points.length - 1].time - points[0].time;
      if (cycle > 0) elapsed %= cycle;
    } else if (sustain !== undefined) {
      elapsed = Math.min(elapsed, points[sustain].time - points[0].time);
    }

    return base + amount * interpolateAtTime(points, points[0].time + elapsed);
  };

  const stop = (time = context.currentTime) => {
    if (!triggered) return;
    triggered = false;
    stopLoop();
    cancelAndPinParamValue(param, time);
  };

  const release = (time = context.currentTime) => {
    if (!triggered) return;
    // Read the shape before anything touches the param, so a future-dated release hands
    // off the value the envelope will actually have reached rather than today's.
    const holdValue = valueAt(time);

    // Deliberately not stop(): its pin would write the param's stale value at exactly
    // the instant releaseEnvelope pins the right one. The second cancel drops the first
    // write so the timeline ends up correct either way, but only one of them is true.
    triggered = false;
    stopLoop();

    releaseEnvelope(param, envelope, time, { base, amount, timeScale }, holdValue);
  };

  return {
    trigger(time = context.currentTime, options = {}) {
      stopLoop();
      triggered = true;
      base = options.base ?? 0;
      amount = options.amount ?? 1;
      timeScale = options.timeScale ?? 1;
      triggerTime = time;

      // Clear only. Every scheduling path below opens with its own setValueAtTime at
      // this same instant, so pinning here would write the param's stale value and be
      // overwritten by the envelope's first point a moment later.
      param.cancelScheduledValues(time);

      const { points } = envelope;
      // A loop repeats the whole envelope; anything else is scheduled once, sustain
      // and release included.
      const duration =
        envelope.loop && points.length > 0
          ? (points[points.length - 1].time - points[0].time) / timeScale
          : 0;

      if (duration <= 0) {
        scheduleEnvelope(param, envelope, time, { base, amount, timeScale });
        return;
      }

      // Cycle n opens at time + n * duration, the first pass included, so there is no
      // pre-loop stage and point 0 lands on the trigger time every pass. Absolute
      // times, not an accumulated sum, so cycles cannot drift apart.
      //
      // Cycle 0 is scheduled here rather than left to the refill below, so a trigger
      // further ahead than the lookahead still has its opening pass queued the moment
      // it is triggered, whatever the refill timer does in between.
      let cycleEnd = scheduleRange(
        param,
        envelope,
        0,
        points.length - 1,
        time,
        base,
        amount,
        timeScale,
      );

      let cycle = 1;
      removeLoop = addLoop(() => {
        const now = context.currentTime;
        const horizon = now + LOOKAHEAD_SECONDS;

        while (time + (cycle + 1) * duration <= now) cycle++;
        while (time + cycle * duration < horizon) {
          // A cycle opens on the same instant the previous one closes, but the two
          // expressions for it can differ by an ULP. When the closing ramp rounds later
          // than the opening setValueAtTime it overwrites the reset and that pass loses
          // its attack, so never open a cycle before the previous one has ended.
          const start = Math.max(time + cycle * duration, cycleEnd);
          cycleEnd = scheduleRange(
            param,
            envelope,
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
    },
    release,
    stop,
    dispose() {
      stop();
    },
  };
}
