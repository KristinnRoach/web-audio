import {
  createEnvelopePlayer,
  assertValidEnvelopeSettings,
  cloneEnvelopeSettings,
  type AutomatableParam,
  type Envelope,
  type EnvelopeClock,
  type EnvelopePlayer,
  type EnvelopeSettings,
  type ScheduleOptions,
} from './Envelope';
import { releaseDuration, scaledDuration } from './envelope-shape';

export type EnvelopeRuntimeTriggerOptions = Omit<ScheduleOptions, 'timeScale'> & {
  /** Additional timing multiplier supplied by the host, such as a playback rate. */
  timeScaleMultiplier?: number;
  /** Optional target-specific shape derived from the stored shape for this run. */
  envelope?: Envelope;
  /** Point index the first pass opens at; see `EnvelopeTriggerOptions.fromPoint`. */
  fromPoint?: number;
};

/** Temporary settings compatibility around the parameter-bound envelope player. */
export class EnvelopeRuntime {
  #envPlayer: EnvelopePlayer | null = null;

  constructor(
    readonly clock: EnvelopeClock,
    settings: EnvelopeSettings,
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
    return this.#settings.envelope.mode.type === 'loop';
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
      this.#settings,
      0,
      this.#settings.envelope.points.length - 1,
      timeScaleMultiplier,
    );
  }

  releaseDuration(timeScaleMultiplier = 1) {
    if (this.#envPlayer) return this.#envPlayer.releaseDuration();
    return releaseDuration(this.#settings, timeScaleMultiplier);
  }

  /** Absolute time of the active player's next loop boundary. */
  nextCycleTime(): number | null {
    return this.#envPlayer?.nextCycleTime(this.clock.currentTime) ?? null;
  }

  applySettings(settings: EnvelopeSettings) {
    assertValidEnvelopeSettings(settings);
    this.#settings = cloneEnvelopeSettings(settings);
  }

  /**
   * Moves the sustain point's value on the running note.
   *
   * The exception to "a run's inputs are fixed once they are on the timeline": the hold
   * is an absence of events, so it can be edited in place. Everything else still waits
   * for a seam. Edits the run only; `applySettings` is what changes the stored shape.
   */
  setSustainValue(value: number, glide?: number) {
    this.#envPlayer?.setSustainValue(value, this.clock.currentTime, glide);
  }

  trigger(param: AutomatableParam, startTime: number, options: EnvelopeRuntimeTriggerOptions = {}) {
    // The constructor and applySettings both validate; trigger was the one entry point
    // that took a caller-supplied shape on trust. An out-of-range sustain index throws
    // inside the player instead, which is a worse place to find out. The stored
    // enabled/timeScale are already valid, so this checks the new shape and nothing else.
    //
    // Validate before replacing the current player, so a rejected shape leaves it alone.
    if (options.envelope) {
      assertValidEnvelopeSettings({ ...this.#settings, envelope: options.envelope });
    }

    const sourceEnvelope = options.envelope ?? this.#settings.envelope;
    const timeScale = this.#settings.timeScale * (options.timeScaleMultiplier ?? 1);
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
    this.#envPlayer = createEnvelopePlayer(this.clock, param);
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
