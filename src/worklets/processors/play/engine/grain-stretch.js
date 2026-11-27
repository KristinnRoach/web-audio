// Grain timestretch: a hop scheduler. A time position moves through the source at
// original speed. Every hop the playhead hands off to a fading grain (see GrainPool)
// and restarts at the time position, then reads on at the note rate. So pitch follows
// the note while duration stays the source's, for any material.
//
// Each hand-off fades over one hop, so a grain rises over one hop and falls over the
// next: 50% overlap with a triangle window. Same interface as PeriodLockStretcher, so
// the voice and pass scheduler treat both alike.

const HOP_SECONDS = 0.03; // 60 ms grains; reasonable: 0.01 - 0.1

export class GrainStretcher {
  #grains;
  #enabled = false;
  #hopFrames;
  #framesToHop = 0;
  #timePosition = 0;

  /**
   * @param {number} contextSampleRate Audio-context sample rate in Hz.
   * @param {import('./grain-pool.js').GrainPool} grains The voice's grain pool.
   */
  constructor(contextSampleRate, grains) {
    this.#grains = grains;
    this.#hopFrames = Math.max(1, Math.round(contextSampleRate * HOP_SECONDS));
  }

  get canStretch() {
    return this.#enabled;
  }

  /** The time position, in source samples. */
  get originalSpeedPosition() {
    return this.#timePosition;
  }

  // Fades go to the grain pool; there is no separate fade head.
  get fadeOutPosition() {
    return null;
  }

  get crossfadeMix() {
    return 0;
  }

  setEnabled(enabled, playheadPosition) {
    this.#enabled = enabled;
    this.reset(playheadPosition);
  }

  reset(position = 0) {
    this.#timePosition = position;
    this.#framesToHop = this.#hopFrames;
  }

  /**
   * Called before the current output sample renders. On a hop, starts a fading grain
   * where the playhead is and returns where it restarts, to pass to `advance`.
   * @returns {number | null}
   */
  prepareJump(active, playheadPosition, playbackRate, startSamples, endSamples) {
    if (!active || --this.#framesToHop > 0) return null;
    this.#framesToHop = this.#hopFrames;
    const direction = playbackRate < 0 ? -1 : 1;
    const target = this.#timePosition + direction;
    if (target < startSamples || target >= endSamples) return null;
    this.#grains.fadeOut(direction, this.#hopFrames * Math.abs(playbackRate));
    return target;
  }

  /** Moves the time position on by one sample; returns the next playhead position. */
  advance(active, playheadPosition, playbackRate, jumpTarget) {
    const nextPosition = jumpTarget ?? playheadPosition + playbackRate;
    if (!active) {
      this.reset(nextPosition);
      return nextPosition;
    }
    this.#timePosition += playbackRate < 0 ? -1 : 1;
    return nextPosition;
  }
}
