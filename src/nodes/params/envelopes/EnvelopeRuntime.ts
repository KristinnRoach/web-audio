import { createEnvelope, type EnvelopeClock, type EnvelopePlayer } from './Envelope';
import type { AutomatableParam, ScheduleOptions } from './envelope-scheduling';
import {
  assertValidEnvelopeConfig,
  cloneEnvelopeConfig,
  type EnvelopeConfig,
} from './envelope-config';
import {
  assertValidEnvelopeShape,
  releaseDuration as releaseStageDuration,
  scaledDuration,
  type EnvelopeShape,
} from './envelope-shape';

export type EnvelopeRuntimeTriggerOptions = Omit<ScheduleOptions, 'timeScale'> & {
  /**
   * The run's timing multiplier, required because the caller composes it. A host
   * following a sample's playback rate passes `config.timeScale * rate`; a host that
   * does not still passes `config.timeScale`.
   */
  timeScale: number;
  /** Optional target-specific shape derived from the stored shape for this run. */
  envelope?: EnvelopeShape;
  /** Point index the first pass opens at; see `EnvelopeTriggerOptions.fromPoint`. */
  fromPoint?: number;
};

/** Temporary config compatibility around the parameter-bound envelope player. */
export class EnvelopeRuntime {
  #envPlayer: EnvelopePlayer | null = null;

  constructor(
    readonly clock: EnvelopeClock,
    envelopeConfig: EnvelopeConfig,
  ) {
    assertValidEnvelopeConfig(envelopeConfig);
    this.#config = cloneEnvelopeConfig(envelopeConfig);
  }

  #config: EnvelopeConfig;

  get config(): EnvelopeConfig {
    return this.#config;
  }

  get enabled() {
    return this.#config.enabled;
  }

  get loop() {
    return this.#config.envelope.mode.type === 'loop';
  }

  /** Last point reached by the active player. */
  currentPoint(): number | null {
    return this.#envPlayer?.currentPoint(this.clock.currentTime) ?? null;
  }

  /** Idle: the stored shape at `timeScale`. Live: the active run's own scale, as triggered. */
  duration(timeScale = this.#config.timeScale) {
    if (this.#envPlayer) return this.#envPlayer.duration();
    const { points } = this.#config.envelope;
    return scaledDuration(points, 0, points.length - 1, timeScale);
  }

  /** Idle: the stored shape at `timeScale`. Live: the active run's own scale, as triggered. */
  releaseDuration(timeScale = this.#config.timeScale) {
    if (this.#envPlayer) return this.#envPlayer.releaseDuration();
    const { points, release } = this.#config.envelope;
    return releaseStageDuration(points, release, timeScale);
  }

  /** Absolute time of the active player's next loop boundary. */
  nextCycleTime(): number | null {
    return this.#envPlayer?.nextCycleTime(this.clock.currentTime) ?? null;
  }

  update(config: EnvelopeConfig) {
    assertValidEnvelopeConfig(config);
    this.#config = cloneEnvelopeConfig(config);
  }

  /**
   * Moves the sustain point's value on the running note.
   *
   * The exception to "a run's inputs are fixed once they are on the timeline": the hold
   * is an absence of events, so it can be edited in place. Everything else still waits
   * for a seam. Edits the run only; `update` is what changes the stored shape.
   */
  setSustainValue(value: number, glide?: number) {
    this.#envPlayer?.setSustainValue(value, this.clock.currentTime, glide);
  }

  trigger(param: AutomatableParam, startTime: number, options: EnvelopeRuntimeTriggerOptions) {
    // `Envelope.trigger` validates the shape too, but only after the handover below has
    // already stopped the outgoing run. Checking here first leaves it alone on a reject.
    if (options.envelope) assertValidEnvelopeShape(options.envelope);

    const sourceEnvelope = options.envelope ?? this.#config.envelope;
    const scheduledStartTime = Math.max(this.clock.currentTime, startTime);
    const schedule = {
      base: options.base,
      amount: options.amount,
      timeScale: options.timeScale,
      // Read only by looping runs; every other shape is scheduled in one pass from 0.
      fromPoint: options.fromPoint ?? 0,
    };

    // Stop the outgoing run *at the handover*, not at `now`: that cancels its queued
    // lookahead from there on while leaving everything before it to play out, so a
    // trigger scheduled ahead takes over without cutting the current run short. The
    // pin it writes is the param's stale value, immediately cancelled and replaced by
    // the new run's first point at the same instant.
    this.#envPlayer?.stop(scheduledStartTime);
    this.#envPlayer = createEnvelope(this.clock, param);
    this.#envPlayer.trigger(sourceEnvelope, scheduledStartTime, schedule);
  }

  release(startTime: number) {
    if (!this.#envPlayer) return;

    const releaseTime = Math.max(this.clock.currentTime, startTime);
    this.#envPlayer.release(releaseTime);
  }

  dispose() {
    this.#envPlayer?.dispose();
    this.#envPlayer = null;
  }
}
