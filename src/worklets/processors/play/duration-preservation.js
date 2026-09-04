import {
  findNearestSlopeMatchedZeroCrossing,
  findNearestZeroCrossing,
} from "@/worklets/shared/utils/findNearestZeroCrossing.js";

/**
 * Owns the private timeline and correction state for zero-crossing duration preservation.
 * Playback position, playback rate, loop state, and zero crossings remain caller-owned inputs.
 * Methods return playback positions and never mutate the caller's transport state.
 */
export class DurationPreserver {
  #enabled = false;
  #maxDriftSamples;
  #timelinePosition = 0;
  #resetPending = false;

  /** @param {number} contextSampleRate Audio-context sample rate in Hz. */
  constructor(contextSampleRate) {
    this.#maxDriftSamples = Math.floor(contextSampleRate * 0.04);
  }

  /** Current unit-rate reference position in samples. */
  get timelinePosition() {
    return this.#timelinePosition;
  }

  /**
   * Enables or disables preservation and aligns its timeline with the authoritative playhead.
   * @param {boolean} enabled Whether preservation should be enabled.
   * @param {number} playbackPosition Current caller-owned playback position in samples.
   */
  setEnabled(enabled, playbackPosition) {
    this.#enabled = Boolean(enabled);
    this.reset(playbackPosition);
  }

  /**
   * Aligns the private timeline with a playback position and clears any pending correction.
   * This does not change whether preservation is enabled.
   * @param {number} [position=0] Playback position in samples.
   */
  reset(position = 0) {
    this.#timelinePosition = position;
    this.#resetPending = false;
  }

  /**
   * Reports whether preservation can run for the current transport context.
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
   * @returns {{outgoingPosition: number, resetTarget: number} | null}
   */
  prepareCorrection(active, playbackPosition, playbackRate, zeroCrossings, referenceSamples) {
    if (!active) return null;

    if (Math.abs(playbackPosition - this.#timelinePosition) > this.#maxDriftSamples) {
      this.#resetPending = true;
    }

    if (!this.#resetPending) return null;

    const direction = playbackRate < 0 ? "left" : "right";
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

    this.#timelinePosition += playbackRate < 0 ? -1 : 1;

    if (canWrapLoop && playbackRate >= 0 && this.#timelinePosition >= loopEndSamples) {
      this.#timelinePosition = loopStartSamples;
    } else if (canWrapLoop && playbackRate < 0 && this.#timelinePosition <= loopStartSamples) {
      this.#timelinePosition = loopEndSamples - 1;
    }

    return nextPosition;
  }
}
