// CustomEnvelope.ts
import { registerNode, NodeID, unregisterNode } from '@/nodes/node-store';

import {
  Message,
  MessageHandler,
  createMessageBus,
  MessageBus,
} from '@/events';

import { EnvelopePoint, EnvelopeType } from './env-types';
import { EnvelopeData } from './EnvelopeData';
import { LibNode } from '@/nodes/LibNode';
import {
  assert,
  cancelAndPinParamValue,
  cancelScheduledParamValues,
  clamp,
  mapToRange,
} from '@/utils';

// ===== CUSTOM ENVELOPE  =====
export class CustomEnvelope implements LibNode {
  readonly nodeId: NodeID;
  readonly nodeType: EnvelopeType = 'default-env';
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
    this.nodeId = registerNode(this.envelopeType, this);
    this.#context = context;
    this.#messages = createMessageBus<Message>(this.nodeId);

    switch (envelopeType) {
      case 'amp-env':
        this.#paramName = 'envGain';
        break;
      case 'pitch-env':
        this.#paramName = 'playbackRate';
        break;
      case 'filter-env':
        this.#paramName = 'lpf';
        break;
      case 'loop-env':
        this.#paramName = 'loopEnd';
        console.warn('CustomEnvelope not implemented for type: loop-env');
        break;
      default:
        console.error(
          `CustomEnvelope not implemented for type: ${envelopeType}`,
        );
        this.#paramName = 'default';
        break;
    }

    this.#isEnabled = initEnable;

    // Use shared data if provided, otherwise create new
    this.#data =
      sharedData ||
      new EnvelopeData([...initialPoints], envPointValueRange, durationSeconds);

    this.#initialized = true;

    this.sendUpstreamMessage(`${this.envelopeType}:created`, {});
  }

  // Delegate data operations to EnvelopeData
  addPoint = (
    time: number,
    value: number,
    curve?: 'linear' | 'exponential',
  ): void => {
    this.#data.addPoint(time, value, curve);
    if (this.#isCurrentlyLooping) this.#loopUpdateFlag = true;
  };

  deletePoint = (index: number): void => {
    this.#data.deletePoint(index);
    if (this.#isCurrentlyLooping) this.#loopUpdateFlag = true;
  };

  updatePoint = (index: number, time?: number, value?: number) => {
    this.#data.updatePoint(index, time, value);
    if (this.#isCurrentlyLooping) this.#loopUpdateFlag = true;
  };

  setSampleDuration(seconds: number) {
    this.#data.setDurationSeconds(seconds);
    return this;
  }

  setValueRange = (range: [number, number]): [number, number] =>
    this.#data.setValueRange(range);

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

  #getCurveSamplingRate(duration: number): number {
    // Higher sample rate for filter envelopes (logarithmic) for smoother curves
    if (this.envelopeType === 'filter-env') {
      return duration < 1 ? 1000 : 750;
    }
    if (this.#data.hasSharpTransitions) {
      return 1000;
    }
    return duration < 1 ? 500 : 250;
  }

  #generateCurve(
    scaledDuration: number,
    endTime = this.baseDuration,
    options: {
      baseValue: number;
      minValue: number;
      maxValue: number;
      playbackRate?: number;
      startFromValue?: number;
    },
  ): Float32Array {
    const sampleRate = this.#getCurveSamplingRate(scaledDuration);
    const numSamples = Math.max(2, Math.floor(scaledDuration * sampleRate));
    const curve = new Float32Array(numSamples);

    const { baseValue, minValue, maxValue, startFromValue } = options;

    // Precompute log scaling for filter-env
    let minLog: number | undefined,
      maxLog: number | undefined,
      logRange: number | undefined;
    if (this.envelopeType === 'filter-env') {
      minLog = Math.log(baseValue);
      maxLog = Math.log(maxValue);
      logRange = maxLog - minLog;
    }

    for (let i = 0; i < numSamples; i++) {
      const normalizedProgress = i / (numSamples - 1);
      const absoluteTime = normalizedProgress * endTime;

      let envValue = this.#data.interpolateValueAtTime(absoluteTime); // normalized [0,1]

      // Blend from startFromValue to envelope trajectory if specified
      if (this.envelopeType === 'filter-env' && minLog && logRange) {
        // Use precomputed log values
        envValue = Math.exp(minLog + logRange * envValue);
        // envValue = mapToRange(envValue, 0, 1, baseValue, maxValue);
      } else if (baseValue !== 1) {
        envValue = envValue * baseValue;
      } else if (startFromValue !== undefined && i === 0) {
        envValue = startFromValue;
      }

      curve[i] = clamp(envValue, minValue, maxValue);
    }

    return curve;
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
    // Firefox fallback - use extremely simple envelope behavior
    if (this.#isFirefox) {
      try {
        const now = this.#context.currentTime;
        const safeStart = Math.max(now + 0.001, startTime);

        // Cancel all previous scheduling
        cancelScheduledParamValues(audioParam, safeStart);

        // Simple attack and decay
        audioParam.linearRampToValueAtTime(
          options.baseValue * 0.8,
          safeStart + 0.01,
        );
        audioParam.linearRampToValueAtTime(
          options.baseValue * 0.5,
          safeStart + 0.1,
        );

        console.debug('Firefox trigger envelope - simple linear ramps');
      } catch (error) {
        console.debug('Firefox trigger envelope failed silently:', error);
      }

      // Still track state for release
      this.#isReleased = false;
      this.#currentPlaybackRate = options.playbackRate;
      return;
    }

    this.#isReleased = false;
    this.#currentPlaybackRate = options.playbackRate;

    // Store active envelope state for dynamic sustain
    this.#activeEnvelope = {
      audioParam,
      startTime,
      options,
    };

    if (this.#loopEnabled) {
      this.#startLoopingEnv(audioParam, startTime, options);
    } else {
      this.#startSingleEnv(audioParam, startTime, options);
    }

    if (!this.releasePoint) {
      console.error('Release point not set, ensure supported by envelope');
      return;
    }

    setTimeout(() => {
      if (this.sustainEnabled || this.#isReleased) return;

      // Auto-release if releaseEnvelope is not called manually and sustain is not enabled
      this.#isReleased = true;

      if (options.voiceId !== undefined) {
        this.sendUpstreamMessage(`${this.envelopeType}:release`, {
          voiceId: options.voiceId,
          midiNote: options.midiNote,
          releasePoint: this.releasePoint, // normalization for display happens in UI code
          remainingDuration: this.effectiveReleaseDuration,
        });
      }
    }, this.effectiveReleaseStartTime * 1000);
  }

  #startSingleEnv(
    audioParam: AudioParam,
    startTime: number,
    options: {
      baseValue: number;
      playbackRate: number;
      voiceId?: string;
      midiNote?: number;
    },
  ) {
    const endIdx = this.sustainEnabled
      ? (this.sustainPointIndex ?? this.points.length - 1)
      : this.points.length - 1;

    const scaledDuration = this.#getScaledDuration(
      0,
      endIdx,
      options.playbackRate,
      this.#timeScale,
    );

    const curve = this.#generateCurve(
      scaledDuration,
      this.sustainEnabled
        ? (this.sustainPoint?.time ?? this.baseDuration)
        : this.baseDuration,
      {
        ...options,
        minValue: audioParam.minValue,
        maxValue: audioParam.maxValue,
        startFromValue: audioParam.value,
      },
    );

    if (options.voiceId !== undefined) {
      this.sendUpstreamMessage(`${this.envelopeType}:trigger`, {
        voiceId: options.voiceId,
        midiNote: options.midiNote,
        duration: scaledDuration,
        sustainEnabled: this.sustainEnabled,
        loopEnabled: false,
        sustainPoint: this.sustainPoint,
        releasePoint: this.releasePoint,
        // curveData: curve,
      });
    }

    const timestamp = this.#context.currentTime;
    const safeStart = Math.max(timestamp, startTime);

    if (scaledDuration < 0.005) {
      audioParam.linearRampToValueAtTime(
        curve[curve.length - 1],
        safeStart + scaledDuration,
      );
      return;
    }

    try {
      cancelScheduledParamValues(audioParam, safeStart);
      audioParam.setValueCurveAtTime(curve, safeStart, scaledDuration);

      // Clear active envelope state when envelope completes (if not sustained)
      if (!this.sustainEnabled) {
        setTimeout(
          () => {
            this.#activeEnvelope = null;
          },
          scaledDuration * 1000 + 100,
        ); // Small buffer to ensure completion
      }
    } catch (error) {
      console.debug('Failed to apply envelope curve due to rapid fire.');
      try {
        cancelScheduledParamValues(audioParam, safeStart);

        audioParam.linearRampToValueAtTime(
          curve[curve.length - 1],
          safeStart + scaledDuration,
        );

        // Clear active envelope state for fallback case too
        if (!this.sustainEnabled) {
          setTimeout(
            () => {
              this.#activeEnvelope = null;
            },
            scaledDuration * 1000 + 100,
          );
        }
      } catch (fallbackError) {
        try {
          audioParam.setValueAtTime(curve[curve.length - 1], safeStart);
          this.#activeEnvelope = null; // Clear immediately for instant set
        } catch {
          // Silent fail
          this.#activeEnvelope = null;
        }
      }
    }
  }

  #isReleased = false;
  #isCurrentlyLooping = false;
  #loopUpdateFlag = false;
  #shouldLoop = () => this.#loopEnabled && !this.#isReleased;

  // Active envelope tracking for dynamic sustain
  #activeEnvelope: {
    audioParam: AudioParam;
    startTime: number;
    options: {
      baseValue: number;
      playbackRate: number;
      voiceId?: string;
      midiNote?: number;
    };
  } | null = null;

  #startLoopingEnv(
    audioParam: AudioParam,
    startTime: number,
    options: {
      baseValue: number;
      playbackRate: number;
      voiceId?: string;
      midiNote?: number;
      minValue?: number;
      maxValue?: number;
    },
  ) {
    if (!this.#shouldLoop()) {
      this.#isCurrentlyLooping = false;
      return;
    }

    let cachedDuration = this.#getScaledDuration(
      this.#data.startPointIndex,
      this.#data.endPointIndex,
      options.playbackRate,
      this.#timeScale,
    );

    let cachedCurve = this.#generateCurve(cachedDuration, this.baseDuration, {
      ...options,
      minValue: audioParam.minValue,
      maxValue: audioParam.maxValue,
      startFromValue: audioParam.value,
    });

    // Send initial trigger message
    if (options.voiceId !== undefined) {
      this.sendUpstreamMessage(`${this.envelopeType}:trigger`, {
        voiceId: options.voiceId,
        midiNote: options.midiNote,
        duration: cachedDuration,
        sustainEnabled: false,
        loopEnabled: true,
        sustainPoint: this.sustainPoint,
        releasePoint: this.releasePoint,
      });
    }

    let phase = Math.max(this.#context.currentTime, startTime);
    const lookAhead = Math.max(0.15, Math.min(cachedDuration * 3, 0.5));
    const safetyBuffer = 0.005;

    let lastScheduledEnd = 0;
    let debugOverlapCount = 0;

    this.#isCurrentlyLooping = true;
    let isScheduling = false;
    let nextScheduleTimeout: number | null = null;

    const scheduleNext = () => {
      if (!this.#shouldLoop()) {
        this.#isCurrentlyLooping = false;
        return;
      }
      // Clear any pending schedule // ? Redundant ?
      if (nextScheduleTimeout !== null) {
        clearTimeout(nextScheduleTimeout);
        nextScheduleTimeout = null;
      }

      if (isScheduling) return; // Prevent concurrent scheduling
      isScheduling = true;

      try {
        // Recalculate if envelope has changed
        if (this.#loopUpdateFlag) {
          cachedDuration = this.#getScaledDuration(
            this.#data.startPointIndex,
            this.#data.endPointIndex,
            options.playbackRate,
            this.#timeScale,
          );

          cachedCurve = this.#generateCurve(cachedDuration, this.baseDuration, {
            ...options,
            minValue: audioParam.minValue,
            maxValue: audioParam.maxValue,
            startFromValue: audioParam.value,
          });
        }

        // Schedule with lookahead
        while (
          phase < this.#context.currentTime + lookAhead &&
          phase >= lastScheduledEnd
        ) {
          if (!this.#shouldLoop()) {
            this.#isCurrentlyLooping = false;
            return;
          }

          const safeCurveDuration = cachedDuration - safetyBuffer;

          // NOTE: IF having overlapping scheduling issues,
          // last resort that should always work is just:  "audioParam.cancelScheduledValues(phase)"

          try {
            audioParam.setValueCurveAtTime(
              cachedCurve,
              phase,
              safeCurveDuration,
            );
          } catch (error) {
            // Curve overlap, advance phase
            debugOverlapCount++;
            if (debugOverlapCount >= 100) {
              console.debug(
                `Multiple curve overlaps in looping envelope, nr of overlaps: ${debugOverlapCount} 
                (loop duration: ${cachedDuration.toFixed(3)}s, buffer: ${safetyBuffer})`,
              );
              debugOverlapCount = 0;
            }
          }

          phase += cachedDuration + safetyBuffer;
          lastScheduledEnd = phase;

          // Convert audio context time to performance time for UI sync
          if (options.voiceId !== undefined) {
            const timestamp = this.#context.getOutputTimestamp();

            if (
              timestamp.contextTime !== undefined &&
              timestamp.performanceTime !== undefined
            ) {
              const elapsedTime = phase - timestamp.contextTime;
              const performanceTime =
                timestamp.performanceTime + elapsedTime * 1000;

              // Schedule UI update at performance time
              const delay = Math.max(0, performanceTime - performance.now());

              setTimeout(() => {
                if (!this.#shouldLoop()) {
                  this.#isCurrentlyLooping = false;
                  return;
                }
                this.sendUpstreamMessage(`${this.envelopeType}:trigger:loop`, {
                  voiceId: options.voiceId,
                  midiNote: options.midiNote,
                  duration: cachedDuration,
                });
              }, delay);
            } else {
              if (!this.#shouldLoop()) {
                this.#isCurrentlyLooping = false;
                return;
              }
              // Fallback: send message immediately if timestamp is not available
              this.sendUpstreamMessage(`${this.envelopeType}:trigger:loop`, {
                voiceId: options.voiceId,
                midiNote: options.midiNote,
                duration: cachedDuration,
              });
            }
          }
        }

        // Schedule next iteration BEFORE releasing lock
        nextScheduleTimeout = setTimeout(() => {
          if (!this.#shouldLoop()) {
            this.#isCurrentlyLooping = false;
            return;
          }
          scheduleNext();
        }, 100);
      } finally {
        isScheduling = false;
      }
    };

    scheduleNext();
  }

  // Temp fix for Firefox - fixed release
  #isFirefox = navigator.userAgent.includes('Firefox');

  // release-click diagnostic
  #debugRelease(data: {
    audioParamValue: number;
    elapsedSeconds?: number;
    envelopeTime?: number;
    releaseStartValue?: number;
    safeStart: number;
    startTime: number;
    activeStartTime?: number;
  }) {
    console.debug('CustomEnvelope release debug:', {
      envelopeType: this.envelopeType,
      ...data,
    });
  }

  releaseEnvelope(
    audioParam: AudioParam,
    startTime: number,
    options?: {
      baseValue?: number;
      playbackRate?: number;
      voiceId?: string;
      midiNote?: number;
      minValue?: number;
      maxValue?: number;
    },
    debugLog: boolean = false,
  ) {
    if (this.#isReleased) return;

    const activeEnvelope = this.#activeEnvelope;
    this.#isReleased = true;
    this.#activeEnvelope = null; // Clear active envelope state

    if (this.#isFirefox) {
      try {
        const now = this.#context.currentTime;

        // For Firefox, we need to be very aggressive about clearing the timeline
        audioParam.cancelScheduledValues(now);

        // Use setTimeout to delay the release ramp to avoid conflicts
        setTimeout(() => {
          try {
            const delayedNow = this.#context.currentTime;
            cancelScheduledParamValues(audioParam, delayedNow);
            audioParam.linearRampToValueAtTime(0, delayedNow + 0.1);
            console.debug(
              'Firefox delayed release envelope - linear ramp to 0',
            );
          } catch (delayedError) {
            console.debug('Firefox delayed release also failed:', delayedError);
          }
        }, 10); // 10ms delay to let any curves finish
      } catch (error) {
        console.debug('Firefox immediate release failed:', error);
        // Try an even more delayed approach
        setTimeout(() => {
          try {
            const veryDelayedNow = this.#context.currentTime;
            audioParam.setValueAtTime(0, veryDelayedNow + 0.05);
          } catch (veryDelayedError) {
            console.debug(
              'Firefox very delayed release failed:',
              veryDelayedError,
            );
          }
        }, 50);
      }

      return; // Don't call #continueFromPoint if using fallback
    }

    const safeStart = Math.max(this.#context.currentTime, startTime);
    const elapsedSeconds = activeEnvelope
      ? Math.max(0, safeStart - activeEnvelope.startTime)
      : undefined;
    const envelopeTime =
      elapsedSeconds !== undefined
        ? Math.min(
            this.baseDuration,
            elapsedSeconds *
              (this.#syncedToPlaybackRate
                ? activeEnvelope!.options.playbackRate
                : 1) *
              this.#timeScale,
          )
        : undefined;
    const releaseStartValue =
      this.envelopeType === 'amp-env' &&
      activeEnvelope?.audioParam === audioParam &&
      envelopeTime !== undefined
        ? this.#clampToPointValueRange(
            this.#data.interpolateValueAtTime(envelopeTime) *
              activeEnvelope.options.baseValue,
          )
        : undefined;

    if (debugLog) {
      this.#debugRelease({
        audioParamValue: audioParam.value,
        elapsedSeconds,
        envelopeTime,
        releaseStartValue,
        safeStart,
        startTime,
        activeStartTime: activeEnvelope?.startTime,
      });
    }

    this.#continueFromPoint(audioParam, startTime, this.releasePointIndex, {
      baseValue: audioParam.value,
      playbackRate: this.#currentPlaybackRate,
      releaseStartValue,
      // Amp release curve must be scaled like releaseStartValue (velocity),
      // otherwise it drifts toward the unscaled trajectory. Other envelope
      // types map baseValue differently, so leave them unscaled.
      curveScale:
        this.envelopeType === 'amp-env'
          ? activeEnvelope?.options.baseValue
          : undefined,
      ...options,
    });
  }

  #continueFromPoint(
    audioParam: AudioParam,
    startTime: number,
    fromPointIndex: number,
    options: {
      baseValue: number;
      playbackRate: number;
      releaseStartValue?: number;
      curveScale?: number;
      voiceId?: string;
      midiNote?: number;
    },
  ) {
    const curveScale = options.curveScale ?? 1;

    const fromPoint = this.points[fromPointIndex];
    const lastPoint = this.points[this.points.length - 1];

    const safeStart = Math.max(this.#context.currentTime, startTime);
    const rawRemainingDuration = lastPoint.time - fromPoint.time; // (before any scaling)

    const scaledRemainingDuration = this.#getScaledDuration(
      fromPointIndex,
      this.points.length - 1,
      options.playbackRate,
      this.#timeScale,
    );

    const targetEndValue = this.#clampToPointValueRange(
      this.#data.interpolateValueAtTime(lastPoint.time) * curveScale,
    );

    if (scaledRemainingDuration <= 0.0001) {
      cancelAndPinParamValue(audioParam, safeStart, options.releaseStartValue);
      audioParam.linearRampToValueAtTime(targetEndValue, safeStart + 0.005);
      return;
    }

    // Generate the release curve shape from sustain point to end
    const sampleRate = this.#getCurveSamplingRate(scaledRemainingDuration);
    const numSamples = Math.max(
      2,
      Math.floor(scaledRemainingDuration * sampleRate),
    );
    const curve = new Float32Array(numSamples);

    // Generate original envelope curve shape
    for (let i = 0; i < numSamples; i++) {
      const normalizedProgress = i / (numSamples - 1);
      const absoluteTime =
        fromPoint.time + normalizedProgress * rawRemainingDuration;

      // Get the envelope's original value at this time
      curve[i] = this.#clampToPointValueRange(
        this.#data.interpolateValueAtTime(absoluteTime) * curveScale,
      );
    }

    // Emit release event
    if (options.voiceId !== undefined) {
      this.sendUpstreamMessage(`${this.envelopeType}:release`, {
        voiceId: options.voiceId,
        midiNote: options.midiNote,
        releasePoint: this.releasePoint,
        remainingDuration: scaledRemainingDuration,
      });
    }

    try {
      // ! Needs testing specifically for Firefox ( and Safari )
      // Capture the handoff value BEFORE cancelling: cancel reverts
      // audioParam.value to its pre-curve value (0 for amp env).
      const currentValue = options.releaseStartValue ?? audioParam.value;
      cancelAndPinParamValue(audioParam, safeStart, currentValue);

      // Adjust curve to start from currentValue instead of envelope's release point
      const adjustedCurve = new Float32Array(curve.length);
      for (let i = 0; i < curve.length; i++) {
        const progress = i / (curve.length - 1);
        // Blend from current value to target curve value
        adjustedCurve[i] = currentValue + progress * (curve[i] - currentValue);
      }
      adjustedCurve[0] = currentValue;

      audioParam.setValueCurveAtTime(
        adjustedCurve,
        safeStart + 0.001,
        scaledRemainingDuration,
      );
    } catch (error) {
      // Silent fallback - this is expected behavior for rapid envelope changes

      try {
        // Fallback to simple linear ramp
        cancelAndPinParamValue(
          audioParam,
          safeStart,
          options.releaseStartValue,
        );

        audioParam.linearRampToValueAtTime(
          targetEndValue,
          safeStart + scaledRemainingDuration,
        );
      } catch (fallbackError) {
        console.warn('Fallback linear ramp also failed:', fallbackError);
        // Final fallback - just set the end value
        try {
          audioParam.setValueAtTime(targetEndValue, safeStart);
        } catch (finalError) {
          console.warn('All AudioParam operations failed:', finalError);
        }
      }
    }
  }

  // ===== LOOP / TIME CONTROL =====

  setTimeScale = (timeScale: number) => {
    this.#timeScale = timeScale;
    if (this.#isCurrentlyLooping) this.#loopUpdateFlag = true;
  };

  setLoopEnabled = (
    enabled: boolean,
    mode: 'normal' | 'ping-pong' | 'reverse' = 'normal',
  ) => {
    if (mode !== 'normal') {
      console.info(
        `Only default env loop mode implemented. Other modes coming soon!`,
      );
    }
    this.#loopEnabled = enabled;
  };

  syncToPlaybackRate = (sync: boolean) => {
    this.#syncedToPlaybackRate = sync;
  };

  // === SUSTAIN / RELEASE ===

  setSustainPoint = (index: number | null) => {
    this.#data.setSustainPoint(index);

    // Handle dynamic sustain - reschedule if envelope is currently active
    if (this.#activeEnvelope && !this.#loopEnabled && !this.#isReleased) {
      this.#rescheduleForSustain();
    }
  };

  #rescheduleForSustain() {
    if (!this.#activeEnvelope || !this.sustainEnabled) return;

    const { audioParam, startTime, options } = this.#activeEnvelope;
    const currentTime = this.#context.currentTime;
    const elapsedTime = currentTime - Math.max(startTime, currentTime);

    // Calculate current position in envelope timeline
    const scaledElapsedTime = this.#syncedToPlaybackRate
      ? elapsedTime * options.playbackRate * this.#timeScale
      : elapsedTime * this.#timeScale;

    const sustainPoint = this.sustainPoint;
    if (!sustainPoint || scaledElapsedTime >= sustainPoint.time) {
      // Already passed sustain point, no action needed
      return;
    }

    try {
      // Cancel current scheduling
      cancelScheduledParamValues(audioParam, currentTime);

      // Calculate remaining duration to sustain point
      const remainingTimeToSustain = sustainPoint.time - scaledElapsedTime;
      const scaledRemainingDuration = this.#syncedToPlaybackRate
        ? remainingTimeToSustain / options.playbackRate / this.#timeScale
        : remainingTimeToSustain / this.#timeScale;

      if (scaledRemainingDuration > 0.001) {
        // Generate curve from current position to sustain point
        const curve = this.#generateCurve(
          scaledRemainingDuration,
          sustainPoint.time,
          {
            ...options,
            minValue: audioParam.minValue,
            maxValue: audioParam.maxValue,
            startFromValue: audioParam.value,
          },
        );

        audioParam.setValueCurveAtTime(
          curve,
          currentTime,
          scaledRemainingDuration,
        );
      }
    } catch (error) {
      // Silent fallback for rapid changes
      console.debug(
        'Dynamic sustain reschedule failed, envelope will continue normally',
      );
    }
  }

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
    return (
      this.points[this.#data.endPointIndex].time -
      this.points[this.releasePointIndex].time
    );
  }

  get effectiveReleaseDuration() {
    return this.#syncedToPlaybackRate
      ? this.baseReleaseDuration / this.#currentPlaybackRate / this.#timeScale
      : this.baseReleaseDuration / this.#timeScale;
  }

  get sustainEnabled() {
    return this.sustainPoint !== null && !this.loopEnabled;
  }

  get sustainPoint(): EnvelopePoint | null {
    return this.sustainPointIndex !== null
      ? this.points[this.sustainPointIndex]
      : null;
  }

  get currentPlaybackRate() {
    return this.#currentPlaybackRate;
  }

  setCurrentPlaybackRate(playbackRate: number) {
    this.#currentPlaybackRate = playbackRate;

    if (this.#syncedToPlaybackRate && this.#isCurrentlyLooping) {
      this.#loopUpdateFlag = true;
    }
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

  #clampToPointValueRange(value: number): number {
    const [min, max] = this.#data.pointValueRange;
    return Math.max(min, Math.min(max, value));
  }

  hasVariation(): boolean {
    const firstValue = this.points[0]?.value ?? 0;
    return this.points.some(
      (point) => Math.abs(point.value - firstValue) > 0.001,
    );
  }

  // === DEFAULTS ===

  static getDefaults(envType: EnvelopeType, durationSeconds = 1) {
    switch (envType) {
      case 'amp-env':
        return {
          points: [
            { time: 0, value: 0, curve: 'exponential' as const },
            {
              time: Math.min(0.005, 0.1 * durationSeconds),
              value: 1,
              curve: 'exponential' as const,
            },
            {
              time: 0.25 * durationSeconds,
              value: 0.75,
              curve: 'exponential' as const,
            },
            {
              time: 0.9 * durationSeconds,
              value: 0.5,
              curve: 'exponential' as const,
            },
            {
              time: durationSeconds,
              value: 0.0,
              curve: 'exponential' as const,
            },
          ],
          envPointValueRange: [0, 1] as [number, number],
          initEnable: true,
          sustainPointIndex: null,
          releasePointIndex: 3, // release from second last point
        };

      case 'pitch-env':
        return {
          points: [
            { time: 0, value: 1, curve: 'exponential' as const },
            {
              time: durationSeconds,
              value: 1,
              curve: 'exponential' as const,
            },
          ],
          envPointValueRange: [0.5, 1.5] as [number, number],
          initEnable: false,
          sustainPointIndex: null,
          releasePointIndex: 1,
        };

      case 'filter-env':
        return {
          points: [
            { time: 0, value: 0, curve: 'exponential' as const },
            {
              time: 0.02 * durationSeconds,
              value: 1,
              curve: 'exponential' as const,
            },
            {
              time: 0.3 * durationSeconds,
              value: 0.2,
              curve: 'exponential' as const,
            },
            {
              time: durationSeconds,
              value: 0,
              curve: 'exponential' as const,
            },
          ],
          envPointValueRange: [0, 1] as [number, number],
          initEnable: false,
          sustainPointIndex: null,
          releasePointIndex: 2,
        };

      default:
        return {
          points: [
            { time: 0, value: 0, curve: 'linear' as const },
            { time: 0.1 * durationSeconds, value: 1, curve: 'linear' as const },
            { time: durationSeconds, value: 0, curve: 'linear' as const },
          ],
          envPointValueRange: [0, 1] as [number, number],
          initEnable: true,
          sustainPointIndex: null,
          releasePointIndex: 1,
        };
    }
  }

  // === CLEAN UP ===

  dispose() {
    this.#loopEnabled = false;
    unregisterNode(this.nodeId);
  }
}
