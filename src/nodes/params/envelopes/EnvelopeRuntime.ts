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
import { releaseDuration, releaseStartTime, scaledDuration } from "./envelope-shape";

export type EnvelopeTriggerDetails = {
  duration: number;
  sustainEnabled: boolean;
  loopEnabled: boolean;
  sustainPoint: Envelope["points"][number] | null;
  releasePoint: Envelope["points"][number] | null;
};

export type EnvelopeReleaseDetails = {
  releasePoint: Envelope["points"][number] | null;
  remainingDuration: number;
};

export type EnvelopeRuntimeCallbacks = {
  onTrigger?: (details: EnvelopeTriggerDetails) => void;
  onRelease?: (details: EnvelopeReleaseDetails) => void;
  onLoop?: (details: { duration: number }) => void;
};

export type EnvelopeRuntimeTriggerOptions = Omit<ScheduleOptions, "timeScale"> & {
  /** Additional timing multiplier supplied by the host, such as a playback rate. */
  timeScaleMultiplier?: number;
  /** Optional target-specific shape derived from the stored shape for this run. */
  envelope?: Envelope;
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
  #autoReleaseSuppressed = false;
  #autoReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #loopTimer: ReturnType<typeof setTimeout> | null = null;
  #timeScaleMultiplier = 1;

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
    return scaledDuration(
      this.#settings,
      0,
      this.#settings.envelope.points.length - 1,
      timeScaleMultiplier,
    );
  }

  releaseDuration(timeScaleMultiplier = 1) {
    return releaseDuration(this.#settings, timeScaleMultiplier);
  }

  applySettings(settings: EnvelopeSettings) {
    assertValidEnvelopeSettings(settings);
    const loopWasOn = this.#settings.envelope.loop;
    this.#settings = cloneEnvelopeSettings(settings);

    if (
      loopWasOn &&
      !settings.envelope.loop &&
      this.#autoReleaseSuppressed &&
      !this.#isReleased &&
      settings.envelope.sustain === undefined
    ) {
      this.#sendAutoRelease();
    }
  }

  trigger(param: AutomatableParam, startTime: number, options: EnvelopeRuntimeTriggerOptions = {}) {
    this.#isReleased = false;
    this.#autoReleaseSuppressed = false;
    this.#timeScaleMultiplier = options.timeScaleMultiplier ?? 1;

    const scheduledEnvelope = options.envelope ?? this.#settings.envelope;
    const schedule = {
      base: options.base,
      amount: options.amount,
      timeScale: this.#settings.timeScale * this.#timeScaleMultiplier,
    };

    this.#scheduler?.dispose();
    this.#scheduler = createEnvelopeScheduler(this.context, param, scheduledEnvelope);
    this.#scheduler.trigger(Math.max(this.context.currentTime, startTime), schedule);

    const { sustain, loop, points } = this.#settings.envelope;
    this.callbacks.onTrigger?.({
      duration: releaseStartTime(this.#settings, this.#timeScaleMultiplier),
      sustainEnabled: sustain !== undefined && !loop,
      loopEnabled: !!loop,
      sustainPoint: sustain === undefined ? null : points[sustain],
      releasePoint: this.#releasePoint,
    });

    this.#armAutoRelease();
    this.#startLoopCallbacks(startTime);
  }

  release(startTime: number) {
    if (this.#isReleased) return;
    this.#isReleased = true;
    this.#autoReleaseSuppressed = false;
    this.#clearTimers();

    this.#scheduler?.release(Math.max(this.context.currentTime, startTime));
    this.#sendRelease();
  }

  stop() {
    this.#isReleased = true;
    this.#autoReleaseSuppressed = false;
    this.#clearTimers();
    this.#scheduler?.dispose();
    this.#scheduler = null;
  }

  dispose() {
    this.stop();
  }

  get #releasePoint() {
    const release = this.#settings.envelope.release ?? this.#settings.envelope.sustain;
    return release === undefined ? null : (this.#settings.envelope.points[release] ?? null);
  }

  #armAutoRelease() {
    this.#clearAutoRelease();
    this.#autoReleaseTimer = setTimeout(
      () => {
        this.#autoReleaseTimer = null;
        if (this.#isReleased) return;
        if (this.#settings.envelope.sustain !== undefined && !this.#settings.envelope.loop) return;

        if (this.#settings.envelope.loop) {
          this.#autoReleaseSuppressed = true;
          return;
        }

        this.#sendAutoRelease();
      },
      releaseStartTime(this.#settings, this.#timeScaleMultiplier) * 1000,
    );
  }

  #sendAutoRelease() {
    this.#autoReleaseSuppressed = false;
    this.#isReleased = true;
    this.#sendRelease();
  }

  #sendRelease() {
    this.callbacks.onRelease?.({
      releasePoint: this.#releasePoint,
      remainingDuration: this.releaseDuration(this.#timeScaleMultiplier),
    });
  }

  #startLoopCallbacks(startTime: number) {
    this.#stopLoopCallbacks();
    if (!this.#settings.envelope.loop) return;

    const { sustain, points } = this.#settings.envelope;
    const loopEnd = sustain ?? points.length - 1;
    const duration = scaledDuration(this.#settings, 0, loopEnd, this.#timeScaleMultiplier);
    if (duration <= 0) return;

    let cycle = 1;
    const tick = () => {
      if (this.#isReleased || !this.#settings.envelope.loop) return this.#stopLoopCallbacks();
      this.callbacks.onLoop?.({ duration });
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

  #stopLoopCallbacks() {
    if (this.#loopTimer === null) return;
    clearTimeout(this.#loopTimer);
    this.#loopTimer = null;
  }

  #clearAutoRelease() {
    if (this.#autoReleaseTimer === null) return;
    clearTimeout(this.#autoReleaseTimer);
    this.#autoReleaseTimer = null;
  }

  #clearTimers() {
    this.#clearAutoRelease();
    this.#stopLoopCallbacks();
  }
}
