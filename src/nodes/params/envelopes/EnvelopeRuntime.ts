import {
  createEnvelope,
  type AutomatableParam,
  type EnvelopeClock,
  type EnvelopePlayer,
  type ScheduleOptions,
} from './Envelope';
import {
  assertValidEnvelopeConfig,
  cloneEnvelopeConfig,
  releaseDuration,
  scaledDuration,
  type EnvelopeConfig,
  type EnvelopeShape,
} from './envelope-shape';

export type EnvelopeRuntimeTriggerOptions = Omit<ScheduleOptions, 'timeScale'> & {
  /** Additional timing multiplier supplied by the host, such as a playback rate. */
  timeScaleMultiplier?: number;
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

  /** Envelope-time position of the active player; see `EnvelopePlayer.position`. */
  position(time = this.clock.currentTime): number | null {
    // Argument first, so a bad timestamp is a bug whether or not a run is live.
    if (!Number.isFinite(time)) {
      throw new RangeError('Envelope position time must be a finite number');
    }
    return this.#envPlayer?.position(time) ?? null;
  }

  /** Last point reached by the active player. */
  currentPoint(): number | null {
    return this.#envPlayer?.currentPoint(this.clock.currentTime) ?? null;
  }

  duration(timeScaleMultiplier = 1) {
    if (this.#envPlayer) return this.#envPlayer.duration();
    return scaledDuration(
      this.#config,
      0,
      this.#config.envelope.points.length - 1,
      timeScaleMultiplier,
    );
  }

  releaseDuration(timeScaleMultiplier = 1) {
    if (this.#envPlayer) return this.#envPlayer.releaseDuration();
    return releaseDuration(this.#config, timeScaleMultiplier);
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

  trigger(param: AutomatableParam, startTime: number, options: EnvelopeRuntimeTriggerOptions = {}) {
    // The constructor and update both validate; trigger was the one entry point
    // that took a caller-supplied shape on trust. An out-of-range sustain index throws
    // inside the player instead, which is a worse place to find out. The stored
    // enabled/timeScale are already valid, so this checks the new shape and nothing else.
    //
    // Validate before replacing the current player, so a rejected shape leaves it alone.
    if (options.envelope) {
      assertValidEnvelopeConfig({
        ...this.#config,
        envelope: options.envelope,
      });
    }

    const sourceEnvelope = options.envelope ?? this.#config.envelope;
    const timeScale = this.#config.timeScale * (options.timeScaleMultiplier ?? 1);
    const scheduledStartTime = Math.max(this.clock.currentTime, startTime);
    const fromPoint = sourceEnvelope.mode.type === 'loop' ? (options.fromPoint ?? 0) : 0;
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
    this.#envPlayer?.stop(scheduledStartTime);
    this.#envPlayer = createEnvelope(this.clock, param);
    this.#envPlayer.trigger(sourceEnvelope, scheduledStartTime, schedule);
  }

  release(startTime: number) {
    if (!this.#envPlayer) return;

    const releaseTime = Math.max(this.clock.currentTime, startTime);
    this.#envPlayer.release(releaseTime);
  }

  stop() {
    this.#envPlayer?.dispose();
    this.#envPlayer = null;
  }

  dispose() {
    this.stop();
  }
}
