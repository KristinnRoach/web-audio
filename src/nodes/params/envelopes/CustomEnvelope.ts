// CustomEnvelope.ts
import { registerNode, NodeID, unregisterNode } from "@/nodes/node-store";

import { Message, MessageHandler, createMessageBus, MessageBus } from "@/events";

import { EnvelopePoint, EnvelopeState, EnvelopeType } from "./env-types";
import { EnvelopeData } from "./EnvelopeData";
import { createEnvelopeScheduler, type EnvelopeScheduler } from "./Envelope";
import { bindEnvelope } from "./bindEnvelope";
import { LibNode } from "@/nodes/LibNode";
import { assert } from "@/utils";

// ===== CUSTOM ENVELOPE  =====
export class CustomEnvelope implements LibNode {
  readonly nodeId: NodeID;
  readonly nodeType: EnvelopeType;
  #initialized = false;

  #context: AudioContext;
  #messages: MessageBus<Message>;

  #data: EnvelopeData;
  #paramName: string;
  envelopeType: EnvelopeType;

  #isEnabled: boolean;
  #loopEnabled = false;
  #syncedToPlaybackRate = false;
  #currentPlaybackRate = 1;

  #timeScale = 1;

  /** Rebuilt from the stored state on every trigger, so the shape it plays is never stale. */
  #scheduler: EnvelopeScheduler | null = null;
  /** The note currently being played, or null between notes. */
  #active: {
    audioParam: AudioParam;
    startTime: number;
    options: { baseValue: number; playbackRate: number; voiceId?: string; midiNote?: number };
  } | null = null;
  #isReleased = false;
  #autoReleaseSuppressed = false;
  #autoReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #loopMessageTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    context: AudioContext,
    envelopeType: EnvelopeType,

    sharedData?: EnvelopeData,

    initialPoints: EnvelopePoint[] = [],
    envPointValueRange: [number, number] = [0, 1],
    durationSeconds = 1,
    initEnable = true,
  ) {
    this.envelopeType = envelopeType;
    this.nodeType = envelopeType;

    switch (envelopeType as EnvelopeType | "loop-env") {
      case "amp-env":
        this.#paramName = "envGain";
        break;
      case "pitch-env":
        this.#paramName = "playbackRate";
        break;
      case "filter-env":
        this.#paramName = "lpf";
        break;
      case "loop-env":
        // this.#paramName = "loopEnd"; // Idea for later
        throw new Error("CustomEnvelope not implemented for type: loop-env");
    }

    this.nodeId = registerNode(this.envelopeType, this);
    this.#context = context;
    this.#messages = createMessageBus<Message>(this.nodeId);

    this.#isEnabled = initEnable;

    // Use shared data if provided, otherwise create new
    this.#data =
      sharedData || new EnvelopeData([...initialPoints], envPointValueRange, durationSeconds);

    this.#initialized = true;

    this.sendUpstreamMessage(`${this.envelopeType}:created`, {});
  }

  // Delegate data operations to EnvelopeData
  addPoint = (time: number, value: number, curve?: "linear" | "exponential"): void => {
    this.#data.addPoint(time, value, curve);
  };

  deletePoint = (index: number): void => {
    this.#data.deletePoint(index);
  };

  updatePoint = (index: number, time?: number, value?: number) => {
    this.#data.updatePoint(index, time, value);
  };

  setDuration(seconds: number) {
    this.#data.setDurationSeconds(seconds);
    return this;
  }

  setValueRange = (range: [number, number]): [number, number] => this.#data.setValueRange(range);

  // Convenience ON/OFF methods
  enable = () => (this.#isEnabled = true);
  disable = () => (this.#isEnabled = false);

  // Property getters
  get initialized() {
    return this.#initialized;
  }

  get data() {
    return this.#data;
  }

  get param() {
    return this.#paramName;
  }

  get isEnabled() {
    return this.#isEnabled;
  }

  get points() {
    return this.#data.points;
  }

  get baseDuration() {
    return this.#data.endTime - this.#data.startTime;
  }

  get effectiveDuration() {
    return this.#getScaledDuration();
  }

  get timeScale() {
    return this.#timeScale;
  }

  /**
   * The range of values applied to the audio param
   **/
  get envPointValueRange() {
    return this.#data.pointValueRange;
  }

  get loopEnabled() {
    return this.#loopEnabled;
  }

  get syncedToPlaybackRate() {
    return this.#syncedToPlaybackRate;
  }

  get numPoints(): number {
    return this.#data.points.length;
  }

  /** @internal */
  getState(): EnvelopeState {
    return {
      enabled: this.#isEnabled,
      timeScale: this.#timeScale,
      playbackRateSync: this.#syncedToPlaybackRate,
      loop: this.#loopEnabled,
      shape: {
        kind: "points",
        points: this.points.map((point) => ({ ...point })),
        valueRange: [this.#data.pointValueRange[0], this.#data.pointValueRange[1]],
        sustainIndex: this.sustainPointIndex,
        releaseIndex: this.releasePointIndex,
      },
    };
  }

  /** @internal */
  applyState(state: EnvelopeState): void {
    this.#data.replacePoints(
      state.shape.points,
      state.shape.valueRange,
      state.shape.sustainIndex,
      state.shape.releaseIndex,
    );
    this.#timeScale = state.timeScale;
    this.#syncedToPlaybackRate = state.playbackRateSync;
    this.setLoopEnabled(state.loop);
    this.#isEnabled = state.enabled;
  }

  // ===== AUDIO OPERATIONS =====

  #getScaledDuration(
    fromIdx = this.#data.startPointIndex,
    toIdx = this.#data.endPointIndex,
    playbackRate = this.#currentPlaybackRate,
    timeScale = this.#timeScale,
  ): number {
    if (
      fromIdx < this.#data.startPointIndex ||
      toIdx > this.#data.endPointIndex ||
      fromIdx >= toIdx
    ) {
      return 0;
    }

    const fromTime = this.points[fromIdx].time;
    const toTime = this.points[toIdx].time;
    const rawDuration = toTime - fromTime;

    let duration = rawDuration;

    // Apply playback rate scaling if synced
    if (this.#syncedToPlaybackRate) {
      duration = duration / playbackRate;
    }

    // Apply time scale
    return duration / timeScale;
  }

  getEffectivePointTime(index: number): number {
    assert(index >= 0 && index <= this.points.length - 1);
    return this.#getScaledDuration(this.#data.startPointIndex, index);
  }

  // ===== AUDIO SCHEDULING =====

  /**
   * Resolves the stored state against one parameter and one note.
   *
   * The ceiling only means anything to a filter envelope, which sweeps from the
   * resting cutoff up towards it. `maxValue` on a cutoff is the filter's own limit.
   */
  #bind(audioParam: AudioParam, baseValue: number, playbackRate: number) {
    return bindEnvelope(this.getState(), this.envelopeType, {
      baseValue,
      playbackRate,
      ceiling: audioParam.maxValue,
    });
  }

  /** Schedules the bound shape from the current state onto the active parameter. */
  #schedule() {
    if (!this.#active) return;
    const { audioParam, startTime, options } = this.#active;

    this.#scheduler?.dispose();

    const { envelope, options: scheduleOptions } = this.#bind(
      audioParam,
      options.baseValue,
      options.playbackRate,
    );

    this.#scheduler = createEnvelopeScheduler(this.#context, audioParam, envelope);
    this.#scheduler.trigger(Math.max(this.#context.currentTime, startTime), scheduleOptions);
  }

  triggerEnvelope(
    audioParam: AudioParam,
    startTime: number,
    options: {
      baseValue: number;
      playbackRate: number;
      voiceId?: string;
      midiNote?: number;
    } = { baseValue: 1, playbackRate: 1 },
  ) {
    this.#isReleased = false;
    this.#autoReleaseSuppressed = false;
    this.#currentPlaybackRate = options.playbackRate;
    this.#active = { audioParam, startTime, options };

    this.#schedule();

    const duration = this.#getScaledDuration(
      this.#data.startPointIndex,
      this.sustainEnabled
        ? (this.sustainPointIndex ?? this.#data.endPointIndex)
        : this.#data.endPointIndex,
      options.playbackRate,
      this.#timeScale,
    );

    if (options.voiceId !== undefined) {
      this.sendUpstreamMessage(`${this.envelopeType}:trigger`, {
        voiceId: options.voiceId,
        midiNote: options.midiNote,
        duration,
        sustainEnabled: this.sustainEnabled,
        loopEnabled: this.#loopEnabled,
        sustainPoint: this.sustainPoint,
        releasePoint: this.releasePoint,
      });
    }

    if (!this.releasePoint) {
      console.error("Release point not set, ensure supported by envelope");
      return;
    }

    this.#startLoopMessages(startTime, options);
    this.#armAutoRelease(options);
  }

  /**
   * Auto-release for a held note with no explicit note-off: the shape has run past its
   * release point on its own, so the voice is told to release.
   *
   * A timer rather than audio scheduling because nothing about the parameter changes
   * here. This is a notification to JS, and only the clock can deliver it.
   */
  #armAutoRelease(options: { voiceId?: string; midiNote?: number }) {
    this.#clearAutoRelease();

    // Sustain and loop both hold indefinitely, so neither has a deadline to arm.
    this.#autoReleaseTimer = setTimeout(() => {
      this.#autoReleaseTimer = null;
      if (this.sustainEnabled || this.#isReleased) return;

      if (this.#loopEnabled) {
        // The loop is still holding the note. Remember the deadline passed so
        // setLoopEnabled can catch up if the loop is switched off mid-note.
        this.#autoReleaseSuppressed = true;
        return;
      }

      this.#sendAutoRelease(options);
    }, this.effectiveReleaseStartTime * 1000);
  }

  #clearAutoRelease() {
    if (this.#autoReleaseTimer === null) return;
    clearTimeout(this.#autoReleaseTimer);
    this.#autoReleaseTimer = null;
  }

  #sendAutoRelease(options?: { voiceId?: string; midiNote?: number }) {
    this.#autoReleaseSuppressed = false;
    this.#isReleased = true;

    if (options?.voiceId !== undefined) {
      this.sendUpstreamMessage(`${this.envelopeType}:release`, {
        voiceId: options.voiceId,
        midiNote: options.midiNote,
        releasePoint: this.releasePoint, // normalization for display happens in UI code
        remainingDuration: this.effectiveReleaseDuration,
      });
    }
  }

  /**
   * Per-cycle notification so a UI can follow a looping envelope.
   *
   * ponytail: a self-correcting timer rather than a callback on the scheduler. The
   * audio side already loops without help; this only drives a display, so it re-reads
   * the audio clock each pass instead of counting its own ticks and drifting. Move it
   * onto a scheduler callback if a consumer ever needs sample-accurate cycle edges.
   */
  #startLoopMessages(startTime: number, options: { voiceId?: string; midiNote?: number }) {
    this.#stopLoopMessages();
    if (!this.#loopEnabled || options.voiceId === undefined) return;

    const duration = this.#getScaledDuration(
      this.#data.startPointIndex,
      this.#data.endPointIndex,
      this.#currentPlaybackRate,
      this.#timeScale,
    );
    if (duration <= 0) return;

    let cycle = 1;
    const tick = () => {
      if (this.#isReleased || !this.#loopEnabled) return this.#stopLoopMessages();

      this.sendUpstreamMessage(`${this.envelopeType}:trigger:loop`, {
        voiceId: options.voiceId,
        midiNote: options.midiNote,
        duration,
      });

      cycle++;
      const nextAt = startTime + cycle * duration;
      this.#loopMessageTimer = setTimeout(
        tick,
        Math.max(0, (nextAt - this.#context.currentTime) * 1000),
      );
    };

    this.#loopMessageTimer = setTimeout(
      tick,
      Math.max(0, (startTime + duration - this.#context.currentTime) * 1000),
    );
  }

  #stopLoopMessages() {
    if (this.#loopMessageTimer === null) return;
    clearTimeout(this.#loopMessageTimer);
    this.#loopMessageTimer = null;
  }

  releaseEnvelope(
    audioParam: AudioParam,
    startTime: number,
    options?: {
      baseValue?: number;
      playbackRate?: number;
      voiceId?: string;
      midiNote?: number;
    },
  ) {
    if (this.#isReleased) return;
    this.#isReleased = true;
    this.#autoReleaseSuppressed = false;
    this.#clearAutoRelease();
    this.#stopLoopMessages();

    const safeStart = Math.max(this.#context.currentTime, startTime);

    // The scheduler hands off from the envelope's own value at `safeStart`, read from
    // the shape rather than from `audioParam.value`. A release scheduled ahead of now
    // therefore starts where the envelope will actually have reached, and the velocity
    // scaling is already in it because depth rides in `amount`.
    this.#scheduler?.release(safeStart);

    if (options?.voiceId !== undefined) {
      this.sendUpstreamMessage(`${this.envelopeType}:release`, {
        voiceId: options.voiceId,
        midiNote: options.midiNote,
        releasePoint: this.releasePoint,
        remainingDuration: this.effectiveReleaseDuration,
      });
    }

    this.#active = null;
  }

  // ===== LOOP / TIME CONTROL =====

  setTimeScale = (timeScale: number) => {
    this.#timeScale = timeScale;
  };

  setLoopEnabled = (enabled: boolean) => {
    this.#loopEnabled = enabled;

    // The auto-release deadline may have passed while the loop was holding the note.
    // A sustain point becomes active again once looping stops, so re-check it here.
    if (!enabled && this.#autoReleaseSuppressed && !this.#isReleased && !this.sustainEnabled) {
      this.#sendAutoRelease(this.#active?.options);
    }
  };

  stopCurrentRun = () => {
    this.#isReleased = true;
    this.#autoReleaseSuppressed = false;
    this.#clearAutoRelease();
    this.#stopLoopMessages();
    this.#scheduler?.dispose();
    this.#scheduler = null;
    this.#active = null;
  };

  syncToPlaybackRate = (sync: boolean) => {
    this.#syncedToPlaybackRate = sync;
  };

  // === SUSTAIN / RELEASE ===

  setSustainPoint = (index: number | null) => {
    this.#data.setSustainPoint(index);

    // Reschedule a running envelope so a sustain point added mid-note takes hold.
    // Rebuilding from the current state is the whole mechanism now: there is no
    // separate mid-note path to keep in step with the trigger path.
    if (this.#active && !this.#isReleased) this.#schedule();
  };

  setReleasePoint = (index: number) => this.#data.setReleasePoint(index);

  get sustainPointIndex() {
    return this.#data.sustainPointIndex;
  }

  get releasePointIndex() {
    return this.#data.releasePointIndex;
  }

  get releasePoint(): EnvelopePoint | null {
    return this.points[this.releasePointIndex] || null;
  }

  get effectiveReleaseStartTime() {
    return this.getEffectivePointTime(this.releasePointIndex);
  }

  get baseReleaseDuration() {
    return this.points[this.#data.endPointIndex].time - this.points[this.releasePointIndex].time;
  }

  get effectiveReleaseDuration() {
    return this.#syncedToPlaybackRate
      ? this.baseReleaseDuration / this.#currentPlaybackRate / this.#timeScale
      : this.baseReleaseDuration / this.#timeScale;
  }

  /** Loop overrides sustain: a looping envelope never holds at the sustain point. */
  get sustainEnabled() {
    return this.sustainPoint !== null && !this.loopEnabled;
  }

  get sustainPoint(): EnvelopePoint | null {
    return this.sustainPointIndex !== null ? this.points[this.sustainPointIndex] : null;
  }

  get currentPlaybackRate() {
    return this.#currentPlaybackRate;
  }

  setCurrentPlaybackRate(playbackRate: number) {
    this.#currentPlaybackRate = playbackRate;
  }

  // === MESSAGES ===

  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  sendUpstreamMessage(type: string, data: any) {
    this.#messages.sendMessage(type, data);
    return this;
  }

  // === UTILS ===

  hasVariation(): boolean {
    const firstValue = this.points[0]?.value ?? 0;
    return this.points.some((point) => Math.abs(point.value - firstValue) > 0.001);
  }

  // === CLEAN UP ===

  dispose() {
    this.#loopEnabled = false;
    this.stopCurrentRun();
    unregisterNode(this.nodeId);
  }
}
