import { wrapLoopPosition } from './loop-edges.js';

// Where no pitch is clear, jumps fall back to short splices of this length.
const UNCLEAR_PITCH_PERIOD_MS = 10;

/**
 * Timestretch that stays near the unit-rate timeline by jumping whole pitch periods.
 * A jump of whole periods continues the same waveform, so the pitch follows the playback rate exactly,
 * and jumps recur at a rate tied to the pitch.
 * Periods come from detectPitchPeriods.
 */
export class PeriodLockStretcher {
  #enabled = false;
  #periods = null;
  #hopSamples = 1;
  #unclearPitchPeriod;
  #timelinePosition = 0;
  #outgoingPosition = null;
  #fadeIndex = 0;
  #fadeLength = 0;
  #fadeDirection = 1;
  #loopLength = 0;

  /** @param {number} contextSampleRate Audio-context sample rate in Hz. */
  constructor(contextSampleRate) {
    this.#unclearPitchPeriod = Math.round(contextSampleRate * (UNCLEAR_PITCH_PERIOD_MS / 1000));
  }

  /**
   * @param {Float32Array | null} periods Pitch period in samples per hop, 0 where unclear.
   * @param {number} hopSamples Source samples between readings.
   */
  setPeriods(periods, hopSamples) {
    this.#periods = periods;
    this.#hopSamples = hopSamples;
  }

  get outgoingPosition() {
    return this.#outgoingPosition;
  }

  /** Smooth equal-gain fade: heads a whole period apart are strongly correlated. */
  get crossfadeMix() {
    const t = this.#fadeIndex / (this.#fadeLength - 1);
    return t * t * (3 - 2 * t);
  }

  get timelinePosition() {
    return this.#timelinePosition;
  }

  setEnabled(enabled, playbackPosition) {
    this.#enabled = enabled;
    this.reset(playbackPosition);
  }

  reset(position = 0) {
    this.#timelinePosition = position;
    this.#outgoingPosition = null;
  }

  isActive(inLoop, loopDurationSamples, pitchPreservationThreshold) {
    return (
      this.#enabled &&
      Boolean(this.#periods?.length) &&
      (!inLoop || loopDurationSamples > pitchPreservationThreshold)
    );
  }

  /**
   * Decides before the current output sample is rendered whether the head jumps after it.
   * @returns {number | null} Where the head lands, to pass to `advance`, or null for no jump.
   */
  prepareJump(active, playbackPosition, playbackRate, startSamples, endSamples) {
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
        // Finish this overlap before starting another jump.
        return null;
      }
    }
    if (!active) return null;

    const period = this.#periodAt(this.#timelinePosition);
    let drift = playbackPosition - this.#timelinePosition;
    // Head and timeline wrap at different moments. The gap across the seam is the real drift.
    if (this.#loopLength > 0 && Math.abs(drift) > this.#loopLength / 2) {
      drift -= Math.sign(drift) * this.#loopLength;
    }
    if (Math.abs(drift) <= period) return null;

    // The head lands where it would be next sample, less whole periods, so the phase carries over.
    const jumpTarget = playbackPosition + playbackRate - Math.round(drift / period) * period;
    if (jumpTarget < startSamples || jumpTarget >= endSamples) return null;

    if (playbackRate !== 0 && playbackPosition >= startSamples && playbackPosition < endSamples) {
      const available =
        playbackRate > 0
          ? endSamples - Math.max(playbackPosition, jumpTarget)
          : Math.min(playbackPosition, jumpTarget) - startSamples;
      // Jumps recur every period / ||rate| - 1| output samples; at most half of that may fade.
      const jumpInterval = period / Math.abs(Math.abs(playbackRate) - 1);
      this.#fadeLength = Math.min(
        Math.floor(Math.min(period, jumpInterval) / 2),
        Math.floor(available / Math.abs(playbackRate)),
      );
      if (this.#fadeLength >= 2) {
        this.#outgoingPosition = playbackPosition;
        this.#fadeIndex = 0;
        this.#fadeDirection = Math.sign(playbackRate);
      }
    }

    return jumpTarget;
  }

  /**
   * Advances the timeline after one output sample and returns the next playhead position.
   */
  advance(
    active,
    playbackPosition,
    playbackRate,
    jumpTarget,
    canWrapLoop,
    loopStartSamples,
    loopEndSamples,
  ) {
    const nextPosition = jumpTarget ?? playbackPosition + playbackRate;

    if (!active) {
      this.#loopLength = 0;
      this.reset(nextPosition);
      return nextPosition;
    }

    if (this.#outgoingPosition !== null) {
      this.#outgoingPosition += playbackRate;
      if (++this.#fadeIndex >= this.#fadeLength) this.#outgoingPosition = null;
    }

    const direction = playbackRate < 0 ? -1 : 1;
    this.#timelinePosition += direction;
    const wrappedTimeline = canWrapLoop
      ? wrapLoopPosition(this.#timelinePosition, direction, loopStartSamples, loopEndSamples)
      : null;
    if (wrappedTimeline !== null) this.#timelinePosition = wrappedTimeline;
    // No seam to measure across until the timeline is inside the loop.
    const timelineInLoop =
      this.#timelinePosition >= loopStartSamples && this.#timelinePosition < loopEndSamples;
    this.#loopLength = canWrapLoop && timelineInLoop ? loopEndSamples - loopStartSamples : 0;

    return nextPosition;
  }

  #periodAt(position) {
    const lastHop = this.#periods.length - 1;
    const hop = Math.max(0, Math.min(lastHop, Math.round(position / this.#hopSamples)));
    return this.#periods[hop] || this.#unclearPitchPeriod;
  }
}
