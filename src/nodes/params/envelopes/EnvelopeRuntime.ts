import {
  createEnvelopeScheduler,
  assertValidEnvelopeSettings,
  cloneEnvelopeSettings,
  type AutomatableParam,
  type Envelope,
  type EnvelopeScheduler,
  type EnvelopeSettings,
  type ScheduleOptions,
} from "./Envelope";
import { releaseDuration, scaledDuration } from "./envelope-shape";

export type EnvelopePointDetails = {
  index: number;
  point: Envelope["points"][number];
  time: number;
};

export type EnvelopeRuntimeCallbacks = {
  onPoint?: (details: EnvelopePointDetails) => void;
  onComplete?: () => void;
};

export type EnvelopeRuntimeTriggerOptions = Omit<ScheduleOptions, "timeScale"> & {
  /** Additional timing multiplier supplied by the host, such as a playback rate. */
  timeScaleMultiplier?: number;
  /** Optional target-specific shape derived from the stored shape for this run. */
  envelope?: Envelope;
  /** Point index the first pass opens at; see `EnvelopeTriggerOptions.fromPoint`. */
  fromPoint?: number;
};

type ActiveEnvelopeRun = {
  envelope: Envelope;
  timeScale: number;
  startTime: number;
};

/**
 * Stateful playback for one envelope bound at trigger time to any automatable parameter.
 *
 * It owns scheduling and lifecycle timing, but has no knowledge of instruments,
 * parameter names, MIDI, buses, or application-level envelope identifiers.
 */
export class EnvelopeRuntime {
  #scheduler: EnvelopeScheduler | null = null;
  #isReleased = false;
  #pointTimers = new Set<ReturnType<typeof setTimeout>>();
  #completionTimer: ReturnType<typeof setTimeout> | null = null;
  #loopTimer: ReturnType<typeof setTimeout> | null = null;
  #activeRun: ActiveEnvelopeRun | null = null;

  constructor(
    readonly context: AudioContext,
    settings: EnvelopeSettings,
    readonly callbacks: EnvelopeRuntimeCallbacks = {},
  ) {
    assertValidEnvelopeSettings(settings);
    this.#settings = cloneEnvelopeSettings(settings);
  }

  #settings: EnvelopeSettings;

  get settings(): EnvelopeSettings {
    return this.#settings;
  }

  get enabled() {
    return this.#settings.enabled;
  }

  get loop() {
    return !!this.#settings.envelope.loop;
  }

  /**
   * Index of the last point a non-looping run has reached, or null when there is no
   * such run. A sustained run stops advancing at its sustain point, so once it is
   * parked there that is the answer for as long as the note is held.
   *
   * ponytail: snaps to a point rather than reporting the exact phase, so resuming from
   * it is only sample-accurate once the run has settled on sustain - mid-attack it is
   * off by up to one segment. Split the segment if a toggle mid-attack ever needs to be
   * click-free.
   */
  currentPoint(): number | null {
    const run = this.#activeRun;
    if (!run || this.#isReleased || run.envelope.loop) return null;

    const { points, sustain } = run.envelope;
    const last = sustain ?? points.length - 1;
    const elapsed = (this.context.currentTime - run.startTime) * run.timeScale;

    let index = 0;
    while (index < last && points[index + 1].time - points[0].time <= elapsed) index++;
    return index;
  }

  duration(timeScaleMultiplier = 1) {
    if (this.#activeRun) {
      return this.#duration(
        this.#activeRun.envelope,
        0,
        this.#activeRun.envelope.points.length - 1,
        this.#activeRun.timeScale,
      );
    }
    return scaledDuration(
      this.#settings,
      0,
      this.#settings.envelope.points.length - 1,
      timeScaleMultiplier,
    );
  }

  releaseDuration(timeScaleMultiplier = 1) {
    if (this.#activeRun) {
      return this.#duration(
        this.#activeRun.envelope,
        this.#activeRun.envelope.release,
        this.#activeRun.envelope.points.length - 1,
        this.#activeRun.timeScale,
      );
    }
    return releaseDuration(this.#settings, timeScaleMultiplier);
  }

  /**
   * Absolute time of the next loop boundary, or null when there is no boundary to wait for.
   *
   * A loop is back at point 0 every cycle, so re-triggering exactly on a boundary is
   * continuous by construction and needs no phase maths. That makes it the one seam
   * where new settings can be swapped in mid-note without a jump, which is why only a
   * looping run answers; everything else applies on its next trigger.
   *
   * A run that has not started yet is already waiting on a seam, so that is the answer.
   * Editors commit on every pointer move, and each commit asks again before the previous
   * handover has arrived; without this the answer would advance a cycle every time and
   * a drag would push its own edit further and further out.
   */
  nextCycleTime(): number | null {
    if (!this.#activeRun?.envelope.loop) return null;
    const { envelope, timeScale, startTime } = this.#activeRun;
    const cycle = this.#duration(envelope, 0, envelope.points.length - 1, timeScale);
    if (cycle <= 0) return null;

    const elapsed = this.context.currentTime - startTime;
    if (elapsed < 0) return startTime;
    return startTime + (Math.floor(elapsed / cycle) + 1) * cycle;
  }

  applySettings(settings: EnvelopeSettings) {
    assertValidEnvelopeSettings(settings);
    this.#settings = cloneEnvelopeSettings(settings);
  }

  trigger(param: AutomatableParam, startTime: number, options: EnvelopeRuntimeTriggerOptions = {}) {
    this.#clearTimers();
    this.#isReleased = false;
    const sourceEnvelope = options.envelope ?? this.#settings.envelope;
    const scheduledEnvelope = {
      ...sourceEnvelope,
      points: sourceEnvelope.points.map((point) => ({ ...point })),
    };
    const timeScale = this.#settings.timeScale * (options.timeScaleMultiplier ?? 1);
    const scheduledStartTime = Math.max(this.context.currentTime, startTime);
    const fromPoint = scheduledEnvelope.loop ? (options.fromPoint ?? 0) : 0;
    // A run opening mid-shape is anchored on where point 0 would have been, so cycle
    // boundaries and durations are read off the same grid as a run that started there.
    const anchor = scheduledStartTime - this.#duration(scheduledEnvelope, 0, fromPoint, timeScale);
    this.#activeRun = { envelope: scheduledEnvelope, timeScale, startTime: anchor };
    const schedule = {
      base: options.base,
      amount: options.amount,
      timeScale,
      fromPoint,
    };

    // Stop the outgoing run *at the handover*, not at `now`: that cancels its queued
    // lookahead from there on while leaving everything before it to play out, so a
    // trigger scheduled ahead takes over without cutting the current run short. The
    // pin it writes is the param's stale value, immediately cancelled and replaced by
    // the new run's first point at the same instant.
    this.#scheduler?.stop(scheduledStartTime);
    this.#scheduler = createEnvelopeScheduler(this.context, param, scheduledEnvelope);
    this.#scheduler.trigger(scheduledStartTime, schedule);

    if (this.callbacks.onPoint) {
      this.#startPointCallbacks(this.#activeRun, scheduledStartTime, fromPoint);
    }

    if (
      this.callbacks.onComplete &&
      scheduledEnvelope.sustain === undefined &&
      !scheduledEnvelope.loop
    ) {
      this.#armCompletion(
        scheduledStartTime +
          this.#duration(scheduledEnvelope, 0, scheduledEnvelope.points.length - 1, timeScale),
      );
    }
  }

  release(startTime: number) {
    if (this.#isReleased || !this.#activeRun) return;
    this.#isReleased = true;
    this.#clearTimers();

    const releaseTime = Math.max(this.context.currentTime, startTime);
    this.#scheduler?.release(releaseTime);
    const { envelope, timeScale } = this.#activeRun;
    if (this.callbacks.onPoint) this.#scheduleReleasePointCallbacks(this.#activeRun, releaseTime);
    if (this.callbacks.onComplete) {
      this.#armCompletion(
        releaseTime +
          this.#duration(envelope, envelope.release, envelope.points.length - 1, timeScale),
      );
    }
  }

  stop() {
    this.#isReleased = true;
    this.#clearTimers();
    this.#scheduler?.dispose();
    this.#scheduler = null;
    this.#activeRun = null;
  }

  dispose() {
    this.stop();
  }

  #startPointCallbacks(run: ActiveEnvelopeRun, startTime: number, fromPoint = 0) {
    const { envelope, timeScale } = run;

    const end = envelope.loop
      ? envelope.points.length - 1
      : (envelope.sustain ?? envelope.points.length - 1);
    const duration = this.#duration(envelope, 0, end, timeScale);
    if (duration <= 0) return;

    // `run.startTime` is the anchor: `startTime` for a run opening at point 0, earlier
    // for one resuming mid-shape. Cycles after the first are read off the anchor.
    const anchor = run.startTime;
    this.#schedulePointCallbackCycle(envelope, startTime, fromPoint, end, timeScale, fromPoint);

    let cycle = 1;
    const tick = () => {
      if (this.#isReleased || !envelope.loop) {
        return this.#clearLoopTimers();
      }

      this.#schedulePointCallbackCycle(envelope, anchor + cycle * duration, 0, end, timeScale);

      cycle++;
      this.#loopTimer = setTimeout(
        tick,
        Math.max(0, (anchor + cycle * duration - this.context.currentTime) * 1000),
      );
    };

    this.#loopTimer = setTimeout(
      tick,
      Math.max(0, (anchor + duration - this.context.currentTime) * 1000),
    );
  }

  #scheduleReleasePointCallbacks(run: ActiveEnvelopeRun, releaseTime: number) {
    const { envelope, timeScale } = run;
    this.#schedulePointCallbackCycle(
      envelope,
      releaseTime,
      envelope.release + 1,
      envelope.points.length - 1,
      timeScale,
      envelope.release,
    );
  }

  #schedulePointCallbackCycle(
    envelope: Envelope,
    startTime: number,
    from: number,
    to: number,
    timeScale: number,
    fromIndex = from - 1,
  ) {
    if (!this.callbacks.onPoint) return;

    const fromTime = fromIndex < 0 ? envelope.points[0].time : envelope.points[fromIndex].time;
    for (let index = from; index <= to; index++) {
      const time = startTime + (envelope.points[index].time - fromTime) / timeScale;
      const timer = setTimeout(
        () => {
          this.#pointTimers.delete(timer);
          this.callbacks.onPoint?.({ index, point: envelope.points[index], time });
        },
        Math.max(0, (time - this.context.currentTime) * 1000),
      );
      this.#pointTimers.add(timer);
    }
  }

  #armCompletion(time: number) {
    this.#completionTimer = setTimeout(
      () => {
        this.#completionTimer = null;
        this.callbacks.onComplete?.();
      },
      Math.max(0, (time - this.context.currentTime) * 1000),
    );
  }

  #duration(envelope: Envelope, from: number, to: number, timeScale: number) {
    if (from < 0 || to >= envelope.points.length || from >= to) return 0;
    return (envelope.points[to].time - envelope.points[from].time) / timeScale;
  }

  #clearLoopTimers() {
    if (this.#loopTimer === null) return;
    clearTimeout(this.#loopTimer);
    this.#loopTimer = null;
  }

  #clearTimers() {
    this.#pointTimers.forEach((timer) => clearTimeout(timer));
    this.#pointTimers.clear();
    if (this.#completionTimer !== null) {
      clearTimeout(this.#completionTimer);
      this.#completionTimer = null;
    }
    this.#clearLoopTimers();
  }
}

/**
 * Applies an envelope edit at the seam where it is inaudible.
 *
 * A looping run is back at point 0 every cycle, so re-triggering exactly on a boundary
 * is continuous by construction. `apply` runs immediately either way; `retrigger` only
 * runs when there is a boundary to hand over on. Anything else - idle, one-shot,
 * sustained - has no such seam and picks the edit up on its next trigger.
 *
 * The boundary is read before `apply` so the answer describes the run that is actually
 * playing, not the edit replacing it.
 */
export function applyOnNextEnvLoopCycle(
  runtime: EnvelopeRuntime,
  apply: () => void,
  retrigger: (at: number) => void,
): void {
  const at = runtime.nextCycleTime();
  apply();
  if (at !== null) retrigger(at);
}
