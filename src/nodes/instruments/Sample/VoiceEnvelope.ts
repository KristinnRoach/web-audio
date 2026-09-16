import {
  bindEnvelope,
  createEnvelopeScheduler,
  releaseDuration,
  releaseStartTime,
  scaledDuration,
  type EnvelopeScheduler,
  type EnvelopeState,
  type EnvelopeType,
} from "@/nodes/params/envelopes";

/** Which voice parameter each envelope type drives. */
const PARAM_NAME: Record<EnvelopeType, string> = {
  "amp-env": "envGain",
  "pitch-env": "playbackRate",
  "filter-env": "lpf",
};

export type TriggerOptions = {
  /** Velocity for an amp envelope, playback rate for pitch, resting cutoff for filter. */
  baseValue: number;
  playbackRate: number;
};

export type EnvelopeEmit = (type: string, data: Record<string, unknown>) => void;

/**
 * One envelope state bound to one voice parameter.
 *
 * The state is not owned here. `SamplePlayer` holds the single copy and pushes it down,
 * so this is only ever a reader: there are no point editors and no per-field setters,
 * which is what keeps a mid-note change from meaning something different depending on
 * which entry point was used. Everything schedulable is derived from the state at
 * trigger time, so the shape it plays can never be stale.
 */
export class VoiceEnvelope {
  readonly paramName: string;

  #context: AudioContext;
  #type: EnvelopeType;
  #emit: EnvelopeEmit;
  #state: EnvelopeState;

  #scheduler: EnvelopeScheduler | null = null;

  #isReleased = false;
  #autoReleaseSuppressed = false;
  #autoReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #loopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(context: AudioContext, type: EnvelopeType, state: EnvelopeState, emit: EnvelopeEmit) {
    this.#context = context;
    this.#type = type;
    this.#state = state;
    this.#emit = emit;
    this.paramName = PARAM_NAME[type];

    emit(`${type}:created`, {});
  }

  get type() {
    return this.#type;
  }

  get state(): EnvelopeState {
    return this.#state;
  }

  get enabled() {
    return this.#state.enabled;
  }

  /** How long the release tail runs, which is what the voice waits out before freeing. */
  releaseDuration(playbackRate = 1) {
    return releaseDuration(this.#state, playbackRate);
  }

  /**
   * Replaces the state.
   *
   * A running note keeps playing the shape it was triggered with. Reaching into a
   * sounding envelope is its own decision with its own audible consequences (#23), and
   * doing it as a side effect of every edit is what made the old behaviour inconsistent.
   * The one exception is switching the loop off, which has to settle an auto-release
   * that was held back while the loop was holding the note.
   */
  applyState(state: EnvelopeState) {
    const loopWasOn = this.#state.loop;
    this.#state = state;

    if (loopWasOn && !state.loop && this.#autoReleaseSuppressed && !this.#isReleased) {
      if (state.shape.sustainIndex === null) this.#sendAutoRelease();
    }
  }

  trigger(param: AudioParam, startTime: number, options: TriggerOptions) {
    this.#isReleased = false;
    this.#autoReleaseSuppressed = false;

    const { envelope, options: schedule } = bindEnvelope(this.#state, this.#type, {
      baseValue: options.baseValue,
      playbackRate: options.playbackRate,
      ceiling: param.maxValue,
    });

    this.#scheduler?.dispose();
    this.#scheduler = createEnvelopeScheduler(this.#context, param, envelope);
    this.#scheduler.trigger(Math.max(this.#context.currentTime, startTime), schedule);

    const { sustainIndex } = this.#state.shape;
    this.#emit(`${this.#type}:trigger`, {
      duration: releaseStartTime(this.#state, options.playbackRate),
      sustainEnabled: sustainIndex !== null && !this.#state.loop,
      loopEnabled: this.#state.loop,
      sustainPoint: sustainIndex === null ? null : this.#state.shape.points[sustainIndex],
      releasePoint: this.#releasePoint,
    });

    this.#armAutoRelease(options.playbackRate);
    this.#startLoopMessages(startTime, options.playbackRate);
  }

  release(startTime: number) {
    if (this.#isReleased) return;
    this.#isReleased = true;
    this.#autoReleaseSuppressed = false;
    this.#clearTimers();

    this.#scheduler?.release(Math.max(this.#context.currentTime, startTime));

    this.#emit(`${this.#type}:release`, {
      releasePoint: this.#releasePoint,
      remainingDuration: this.releaseDuration(),
    });
  }

  /** Ends the current run without touching the state; the next trigger starts clean. */
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
    return this.#state.shape.points[this.#state.shape.releaseIndex] ?? null;
  }

  /**
   * Tells the voice to let go once a held note has run past its release point on its
   * own. A timer rather than audio scheduling: nothing about the parameter changes
   * here, so only the clock can deliver it.
   *
   * Sustain and loop both hold the note indefinitely. A loop remembers that the
   * deadline passed so switching the loop off can settle it.
   */
  #armAutoRelease(playbackRate: number) {
    this.#clearAutoRelease();

    this.#autoReleaseTimer = setTimeout(
      () => {
        this.#autoReleaseTimer = null;
        if (this.#isReleased) return;
        if (this.#state.shape.sustainIndex !== null && !this.#state.loop) return;

        if (this.#state.loop) {
          this.#autoReleaseSuppressed = true;
          return;
        }

        this.#sendAutoRelease();
      },
      releaseStartTime(this.#state, playbackRate) * 1000,
    );
  }

  #sendAutoRelease() {
    this.#autoReleaseSuppressed = false;
    this.#isReleased = true;

    this.#emit(`${this.#type}:release`, {
      releasePoint: this.#releasePoint,
      remainingDuration: this.releaseDuration(),
    });
  }

  /**
   * Per-cycle notification so a UI can follow a looping envelope.
   *
   * ponytail: a self-correcting timer rather than a callback on the scheduler. The
   * audio side already loops without help and this only drives a display, so it re-reads
   * the audio clock each pass instead of counting its own ticks and drifting. Move it
   * onto a scheduler callback if a consumer ever needs sample-accurate cycle edges.
   */
  #startLoopMessages(startTime: number, playbackRate: number) {
    this.#stopLoopMessages();
    if (!this.#state.loop) return;

    const { sustainIndex, points } = this.#state.shape;
    const loopEnd = sustainIndex ?? points.length - 1;
    const duration = scaledDuration(this.#state, 0, loopEnd, playbackRate);
    if (duration <= 0) return;

    let cycle = 1;
    const tick = () => {
      if (this.#isReleased || !this.#state.loop) return this.#stopLoopMessages();

      this.#emit(`${this.#type}:trigger:loop`, { duration });
      cycle++;

      this.#loopTimer = setTimeout(
        tick,
        Math.max(0, (startTime + cycle * duration - this.#context.currentTime) * 1000),
      );
    };

    this.#loopTimer = setTimeout(
      tick,
      Math.max(0, (startTime + duration - this.#context.currentTime) * 1000),
    );
  }

  #stopLoopMessages() {
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
    this.#stopLoopMessages();
  }
}
