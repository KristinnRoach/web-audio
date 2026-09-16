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
};

type ActiveEnvelopeRun = {
  envelope: Envelope;
  timeScale: number;
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
    this.#activeRun = { envelope: scheduledEnvelope, timeScale };
    const schedule = {
      base: options.base,
      amount: options.amount,
      timeScale,
    };

    this.#scheduler?.dispose();
    this.#scheduler = createEnvelopeScheduler(this.context, param, scheduledEnvelope);
    const scheduledStartTime = Math.max(this.context.currentTime, startTime);
    this.#scheduler.trigger(scheduledStartTime, schedule);
    if (this.callbacks.onPoint) {
      this.#startPointCallbacks(this.#activeRun, scheduledStartTime);
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
    if (this.callbacks.onPoint) this.#startReleasePointCallbacks(this.#activeRun, releaseTime);
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

  #startPointCallbacks(run: ActiveEnvelopeRun, startTime: number) {
    const { envelope, timeScale } = run;
    const end = envelope.loop
      ? envelope.points.length - 1
      : (envelope.sustain ?? envelope.points.length - 1);
    this.#schedulePointRange(envelope, startTime, 0, end, timeScale);
    if (!envelope.loop) return;

    const duration = this.#duration(envelope, 0, end, timeScale);
    if (duration <= 0) return;

    let cycle = 1;
    const tick = () => {
      if (this.#isReleased || !envelope.loop) return this.#stopLoopCallbacks();
      this.#schedulePointRange(envelope, startTime + cycle * duration, 0, end, timeScale);
      cycle++;
      this.#loopTimer = setTimeout(
        tick,
        Math.max(0, (startTime + cycle * duration - this.context.currentTime) * 1000),
      );
    };

    this.#loopTimer = setTimeout(
      tick,
      Math.max(0, (startTime + duration - this.context.currentTime) * 1000),
    );
  }

  #startReleasePointCallbacks(run: ActiveEnvelopeRun, releaseTime: number) {
    const { envelope, timeScale } = run;
    this.#schedulePointRange(
      envelope,
      releaseTime,
      envelope.release + 1,
      envelope.points.length - 1,
      timeScale,
      envelope.release,
    );
  }

  #schedulePointRange(
    envelope: Envelope,
    startTime: number,
    from: number,
    to: number,
    timeScale: number,
    fromIndex = from - 1,
  ) {
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

  #stopLoopCallbacks() {
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
    this.#stopLoopCallbacks();
  }
}
