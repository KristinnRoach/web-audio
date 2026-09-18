import {
  createEnvelopePlayer,
  assertValidEnvelopeSettings,
  cloneEnvelopeSettings,
  type AutomatableParam,
  type Envelope,
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

/**
 * Stateful playback for one envelope bound at trigger time to any automatable parameter.
 *
 * It owns scheduling and lifecycle timing, but has no knowledge of instruments,
 * parameter names, MIDI, buses, or application-level envelope identifiers.
 */
export class EnvelopeRuntime {
  #envPlayer: EnvelopePlayer | null = null;
  #runHasOwnShape = false;

  constructor(
    readonly context: AudioContext,
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
    return !!this.#settings.envelope.loop;
  }

  /**
   * How far into the shape the live run has got at `time`, or `null` when no run is live.
   *
   * **Seconds**, on the same scale `points[i].time` is written in, measured as an offset
   * from `points[0].time`. `0` is point 0, `points[2].time` is point 2.
   *
   * Seconds is required rather than chosen: point times reach the parameter as
   * `startTime + (points[i].time - points[from].time) / timeScale` and land in
   * `linearRampToValueAtTime`, which reads `AudioContext` seconds.
   *
   * It is *not* `context.currentTime - startTime`. Wall seconds are scaled first:
   *
   * ```
   * position = (time - anchorTime) * timeScale
   * ```
   *
   * where `timeScale` is the run's, so `settings.timeScale * timeScaleMultiplier` as it
   * was at trigger. A run playing at twice speed reaches position 1 after half a second
   * of wall clock. Go back the other way with `anchorTime + position / timeScale`.
   *
   * The shape bounds the result: a loop wraps it into `[0, cycle)`, and a sustained run
   * clamps it at the sustain point and stays there while the note is held.
   *
   * `anchorTime` is where point 0 *would have* been, which for a run opened mid-shape
   * with `fromPoint` is earlier than the trigger. The position therefore reads off the
   * same grid either way.
   *
   * A normalized 0..1 phase, if a looping run ever wants one, is `position() / duration()`
   * at the call site. Not an accessor here: it only means anything while looping.
   *
   * Null once released or stopped: the tail runs on its own clock from note-off, so no
   * single offset into the shape describes it.
   *
   * Throws `RangeError` on a non-finite `time`. Null already means "no live run"; letting
   * it also mean "you passed garbage" would leave a caller unable to tell the two apart.
   * An rAF loop calling `position()` with no argument never reaches this, since the
   * default is `context.currentTime`.
   */
  position(time = this.context.currentTime): number | null {
    // Argument first, so a bad timestamp is a bug whether or not a run is live.
    if (!Number.isFinite(time)) {
      throw new RangeError('Envelope position time must be a finite number');
    }
    return this.#envPlayer?.position(time) ?? null;
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
    return this.#envPlayer?.currentPoint(this.context.currentTime) ?? null;
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
    return this.#envPlayer?.nextCycleTime(this.context.currentTime) ?? null;
  }

  applySettings(settings: EnvelopeSettings) {
    assertValidEnvelopeSettings(settings);
    this.#settings = cloneEnvelopeSettings(settings);

    // The one edit the running note picks up. Everything else - timing, curves, the
    // sustain index itself - still waits for the next trigger or loop boundary.
    //
    // Skipped for a run triggered with its own shape, where the points are on a scale
    // the stored settings do not share: the sampler's filter envelope plays Hz mapped
    // from normalized settings, so forwarding the stored value would set a cutoff of
    // 0.3 Hz. Those runs pick the edit up on the next trigger, as before.
    const { sustain } = settings.envelope;
    if (sustain !== undefined && !this.#runHasOwnShape) {
      this.setSustainValue(settings.envelope.points[sustain].value);
    }
  }

  /**
   * Moves the sustain point's value on the running note.
   *
   * The exception to "a run's inputs are fixed once they are on the timeline": the hold
   * is an absence of events, so it can be edited in place. Everything else still waits
   * for a seam. Edits the run only; `applySettings` is what changes the stored shape.
   */
  setSustainValue(value: number, glide?: number) {
    this.#envPlayer?.setSustainValue(value, this.context.currentTime, glide);
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
    this.#runHasOwnShape = options.envelope !== undefined;
    const timeScale = this.#settings.timeScale * (options.timeScaleMultiplier ?? 1);
    const scheduledStartTime = Math.max(this.context.currentTime, startTime);
    const fromPoint = sourceEnvelope.loop ? (options.fromPoint ?? 0) : 0;
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
    this.#envPlayer = createEnvelopePlayer(this.context, param, sourceEnvelope);
    this.#envPlayer.trigger(scheduledStartTime, schedule);
  }

  release(startTime: number) {
    if (!this.#envPlayer) return;

    const releaseTime = Math.max(this.context.currentTime, startTime);
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
