import {
  findNearestSlopeMatchedZeroCrossing,
  findNearestZeroCrossing,
} from '@/worklets/shared/utils/findNearestZeroCrossing.js';
import { wrapLoopPosition } from './loop-edges.js';

// In ms so the audible length is the same at every sample rate.
const DEFAULT_CROSSFADE_DURATION_MS = 5;
// How far the playhead may stray from the unit-rate timeline before a jump back is scheduled.
// Also caps how far from the timeline the slope-matched landing crossing may be.
export const MAX_DRIFT_MS = 40;

/**
 * Owns the private timeline and correction state for zero-crossing timestretch.
 * Playback position, playback rate, loop state, and zero crossings remain caller-owned inputs.
 * Methods return playback positions and never mutate the caller's transport state.
 */
export class ZeroCrossingStretcher {
  #enabled = false;
  #maxDriftSamples;
  #timelinePosition = 0;
  #resetPending = false;
  #crossfadeSamples = 0;
  #sampleRate;
  #outgoingPosition = null;
  #fadeIndex = 0;
  #fadeLength = 0;
  #fadeDirection = 1;

  /** @param {number} contextSampleRate Audio-context sample rate in Hz. */
  constructor(contextSampleRate) {
    this.#maxDriftSamples = Math.floor(contextSampleRate * (MAX_DRIFT_MS / 1000));
    this.#sampleRate = contextSampleRate;
    this.crossfadeDurationMs = DEFAULT_CROSSFADE_DURATION_MS;
  }

  /** Zero restores the original correction path. Changes clear an in-flight fade. */
  set crossfadeDurationMs(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.#crossfadeSamples =
      milliseconds === 0 ? 0 : Math.max(2, Math.round(this.#sampleRate * (milliseconds / 1000)));
    this.#outgoingPosition = null;
  }

  get outgoingPosition() {
    return this.#outgoingPosition;
  }

  /** Smooth equal-gain fade: matched crossings may still be strongly correlated. */
  get crossfadeMix() {
    const t = this.#fadeIndex / (this.#fadeLength - 1);
    return t * t * (3 - 2 * t);
  }

  /** Current unit-rate reference position in samples. */
  get timelinePosition() {
    return this.#timelinePosition;
  }

  /**
   * Enables or disables the stretch and aligns its timeline with the authoritative playhead.
   * @param {boolean} enabled Whether the stretch should be enabled.
   * @param {number} playbackPosition Current caller-owned playback position in samples.
   */
  setEnabled(enabled, playbackPosition) {
    this.#enabled = Boolean(enabled);
    this.reset(playbackPosition);
  }

  /**
   * Aligns the private timeline with a playback position and clears any pending correction.
   * This does not change whether the stretch is enabled.
   * @param {number} [position=0] Playback position in samples.
   */
  reset(position = 0) {
    this.#timelinePosition = position;
    this.#resetPending = false;
    this.#outgoingPosition = null;
  }

  /**
   * Reports whether the stretch can run for the current transport context.
   * Loops at or below the threshold are intentionally excluded.
   * @param {number[]} zeroCrossings Zero-crossing positions in ascending sample order.
   * @param {boolean} loopEnabled Whether sample looping is enabled.
   * @param {number} loopDurationSamples Current loop length in samples.
   * @param {number} pitchPreservationThreshold Loops must be longer than this sample count.
   * @returns {boolean}
   */
  isActive(zeroCrossings, loopEnabled, loopDurationSamples, pitchPreservationThreshold) {
    return (
      this.#enabled &&
      Boolean(zeroCrossings?.length) &&
      (!loopEnabled || loopDurationSamples > pitchPreservationThreshold)
    );
  }

  /**
   * Prepares a correction before the current output sample is rendered.
   * When non-null, render `outgoingPosition` now and pass `resetTarget` to `advance`.
   * @param {boolean} active Result of `isActive` for the current render quantum.
   * @param {number} playbackPosition Current caller-owned playback position in samples.
   * @param {number} playbackRate Signed source-sample advance per output sample.
   * @param {number[]} zeroCrossings Zero-crossing positions in ascending sample order.
   * @param {Float32Array} referenceSamples Channel used to detect the zero crossings.
   * @param {number} [startSamples=0] Inclusive source boundary for both fade heads.
   * @param {number} [endSamples=referenceSamples.length] Exclusive source boundary.
   * @returns {{outgoingPosition: number, resetTarget: number} | null}
   */
  prepareCorrection(
    active,
    playbackPosition,
    playbackRate,
    zeroCrossings,
    referenceSamples,
    startSamples = 0,
    endSamples = referenceSamples.length,
  ) {
    if (this.#outgoingPosition !== null) {
      if (
        !active ||
        Math.sign(playbackRate) !== this.#fadeDirection ||
        this.#outgoingPosition < startSamples ||
        this.#outgoingPosition >= endSamples ||
        playbackPosition < startSamples ||
        playbackPosition >= endSamples
      ) {
        this.#outgoingPosition = null;
      } else {
        // Finish this overlap before starting another correction.
        return null;
      }
    }
    if (!active) return null;

    if (Math.abs(playbackPosition - this.#timelinePosition) > this.#maxDriftSamples) {
      this.#resetPending = true;
    }

    if (!this.#resetPending) return null;

    const direction = playbackRate < 0 ? 'left' : 'right';
    const outgoingPosition = findNearestZeroCrossing(zeroCrossings, playbackPosition, direction);

    if (Math.abs(outgoingPosition - playbackPosition) > Math.abs(playbackRate)) return null;

    const resetTarget = findNearestSlopeMatchedZeroCrossing(
      zeroCrossings,
      referenceSamples,
      this.#timelinePosition,
      outgoingPosition,
      this.#maxDriftSamples,
    );
    if (resetTarget === null) return null;

    if (
      this.#crossfadeSamples > 0 &&
      resetTarget !== outgoingPosition &&
      playbackRate !== 0 &&
      outgoingPosition >= startSamples &&
      outgoingPosition < endSamples &&
      resetTarget >= startSamples &&
      resetTarget < endSamples
    ) {
      // Keep both heads inside the trim/loop; never read across an edge for a fade.
      const available =
        playbackRate > 0
          ? endSamples - Math.max(outgoingPosition, resetTarget)
          : Math.min(outgoingPosition, resetTarget) - startSamples;
      // Jumps recur every maxDrift / ||rate| - 1| output samples; at most half of that may fade.
      const jumpInterval = this.#maxDriftSamples / Math.abs(Math.abs(playbackRate) - 1);
      this.#fadeLength = Math.min(
        this.#crossfadeSamples,
        Math.floor(available / Math.abs(playbackRate)),
        Math.floor(jumpInterval / 2),
      );
      if (this.#fadeLength >= 2) {
        this.#outgoingPosition = outgoingPosition;
        this.#fadeIndex = 0;
        this.#fadeDirection = Math.sign(playbackRate);
      }
    }

    this.#resetPending = false;
    return { outgoingPosition, resetTarget };
  }

  /**
   * Advances the private timeline after one output sample and returns the next playhead position.
   * @param {boolean} active Result of `isActive` for the current render quantum.
   * @param {number} playbackPosition Position used to render the current sample.
   * @param {number} playbackRate Signed source-sample advance per output sample.
   * @param {number | null} resetTarget Correction returned by `prepareCorrection`, or null.
   * @param {boolean} canWrapLoop Whether the current loop may wrap again.
   * @param {number} loopStartSamples Inclusive loop start in samples.
   * @param {number} loopEndSamples Exclusive loop end in samples.
   * @returns {number} Playback position for the next output sample.
   */
  advance(
    active,
    playbackPosition,
    playbackRate,
    resetTarget,
    canWrapLoop,
    loopStartSamples,
    loopEndSamples,
  ) {
    const nextPosition = resetTarget === null ? playbackPosition + playbackRate : resetTarget;

    if (!active) {
      this.reset(nextPosition);
      return nextPosition;
    }

    if (this.#outgoingPosition !== null) {
      this.#outgoingPosition += playbackRate;
      if (++this.#fadeIndex >= this.#fadeLength) this.#outgoingPosition = null;
    }

    const direction = playbackRate < 0 ? -1 : 1;
    this.#timelinePosition += direction;

    // Same loop rule as the playhead, at unit rate
    const wrappedTimeline = canWrapLoop
      ? wrapLoopPosition(this.#timelinePosition, direction, loopStartSamples, loopEndSamples)
      : null;
    if (wrappedTimeline !== null) this.#timelinePosition = wrappedTimeline;

    return nextPosition;
  }
}
