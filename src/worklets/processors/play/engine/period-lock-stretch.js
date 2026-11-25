// Where no pitch is clear, jumps fall back to short splices of this length.
const UNCLEAR_PITCH_PERIOD_MS = 10;

/**
 * Keeps the playhead near the original-speed position by jumping whole pitch periods.
 * A jump of whole periods continues the same waveform, so the pitch follows the playback rate exactly,
 * and jumps recur at a rate tied to the pitch.
 * Periods come from detectPitchPeriods.
 */
export class PeriodLockStretcher {
  #enabled = false;
  #periods = null;
  #hopSamples = 1;
  #unclearPitchPeriod;
  #originalSpeedPosition = 0;
  #fadeOutPosition = null;
  #fadeIndex = 0;
  #fadeLength = 0;
  #fadeDirection = 1;

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

  get fadeOutPosition() {
    return this.#fadeOutPosition;
  }

  /** Smooth equal-gain fade: heads a whole period apart are strongly correlated. */
  get crossfadeMix() {
    const t = this.#fadeIndex / (this.#fadeLength - 1);
    return t * t * (3 - 2 * t);
  }

  get originalSpeedPosition() {
    return this.#originalSpeedPosition;
  }

  setEnabled(enabled, playheadPosition) {
    this.#enabled = enabled;
    this.reset(playheadPosition);
  }

  reset(position = 0) {
    this.#originalSpeedPosition = position;
    this.#fadeOutPosition = null;
  }

  get canStretch() {
    return this.#enabled && Boolean(this.#periods?.length);
  }

  /**
   * Decides before the current output sample is rendered whether the head jumps after it.
   * @returns {number | null} Where the head lands, to pass to `advance`, or null for no jump.
   */
  prepareJump(active, playheadPosition, playbackRate, startSamples, endSamples) {
    if (this.#fadeOutPosition !== null) {
      if (
        !active ||
        Math.sign(playbackRate) !== this.#fadeDirection ||
        this.#fadeOutPosition < startSamples ||
        this.#fadeOutPosition >= endSamples ||
        playheadPosition < startSamples ||
        playheadPosition >= endSamples
      ) {
        this.#fadeOutPosition = null;
      } else {
        // Finish this overlap before starting another jump.
        return null;
      }
    }
    if (!active) return null;

    const period = this.#periodAt(this.#originalSpeedPosition);
    const drift = playheadPosition - this.#originalSpeedPosition;
    if (Math.abs(drift) <= period) return null;

    // The head lands where it would be next sample, less whole periods, so the phase carries over.
    const jumpTarget = playheadPosition + playbackRate - Math.round(drift / period) * period;
    if (jumpTarget < startSamples || jumpTarget >= endSamples) return null;

    if (playbackRate !== 0 && playheadPosition >= startSamples && playheadPosition < endSamples) {
      const available =
        playbackRate > 0
          ? endSamples - Math.max(playheadPosition, jumpTarget)
          : Math.min(playheadPosition, jumpTarget) - startSamples;
      // Jumps recur every period / ||rate| - 1| output samples; at most half of that may fade.
      const jumpInterval = period / Math.abs(Math.abs(playbackRate) - 1);
      this.#fadeLength = Math.min(
        Math.floor(Math.min(period, jumpInterval) / 2),
        Math.floor(available / Math.abs(playbackRate)),
      );
      if (this.#fadeLength >= 2) {
        this.#fadeOutPosition = playheadPosition;
        this.#fadeIndex = 0;
        this.#fadeDirection = Math.sign(playbackRate);
      }
    }

    return jumpTarget;
  }

  /**
   * Advances the original-speed position by one sample, or syncs it to the playhead when inactive.
   * Returns the next playhead position.
   */
  advance(active, playheadPosition, playbackRate, jumpTarget) {
    const nextPosition = jumpTarget ?? playheadPosition + playbackRate;

    if (!active) {
      this.reset(nextPosition);
      return nextPosition;
    }

    if (this.#fadeOutPosition !== null) {
      this.#fadeOutPosition += playbackRate;
      if (++this.#fadeIndex >= this.#fadeLength) this.#fadeOutPosition = null;
    }

    const direction = playbackRate < 0 ? -1 : 1;
    this.#originalSpeedPosition += direction;
    return nextPosition;
  }

  #periodAt(position) {
    const lastHop = this.#periods.length - 1;
    const hop = Math.max(0, Math.min(lastHop, Math.round(position / this.#hopSamples)));
    return this.#periods[hop] || this.#unclearPitchPeriod;
  }
}
