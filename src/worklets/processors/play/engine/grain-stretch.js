// Grain timestretch: a hop scheduler. A time position moves through the source at
// `speed` times original speed (0 freezes it). Every hop the playhead hands off to a
// fading grain (see GrainPool) and restarts at the time position, offset by up to
// `scatter` at random, then reads on at the note rate. So pitch follows the note while
// duration follows the time position, for any material.
//
// Each hand-off fades over one hop, so a grain rises over one hop and falls over the
// next: 50% overlap with a triangle window. Same interface as PeriodLockStretcher, so
// the voice and pass scheduler treat both alike.

const DEFAULT_GRAIN_SECONDS = 0.06; // reasonable: 0.01 - 0.2

export class GrainStretcher {
  #grains;
  #random;
  #sampleRate;
  #enabled = false;
  #hopFrames = 1;
  #framesToHop = 0;
  #timePosition = 0;
  #speed = 1;
  #scatterSamples = 0;

  /**
   * @param {number} contextSampleRate Audio-context sample rate in Hz.
   * @param {import('./grain-pool.js').GrainPool} grains The voice's grain pool.
   * @param {() => number} random Random values in [0, 1).
   */
  constructor(contextSampleRate, grains, random = Math.random) {
    this.#grains = grains;
    this.#random = random;
    this.#sampleRate = contextSampleRate;
    this.setSize(DEFAULT_GRAIN_SECONDS);
  }

  /** Time position speed: 1 is original speed, 0 freezes, 2 is twice as fast. */
  setSpeed(speed) {
    this.#speed = Math.max(0, speed);
  }

  /** Largest random offset of a grain's start from the time position, in seconds. */
  setScatter(seconds) {
    this.#scatterSamples = Math.max(0, seconds) * this.#sampleRate;
  }

  /** Grain length in seconds; grains start every half grain. */
  setSize(seconds) {
    this.#hopFrames = Math.max(1, Math.round((Math.max(0, seconds) * this.#sampleRate) / 2));
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
    const scatter = (this.#random() * 2 - 1) * this.#scatterSamples;
    const target = Math.min(
      Math.max(this.#timePosition + direction * this.#speed + scatter, startSamples),
      endSamples - 1,
    );
    if (target < startSamples) return null;
    this.#grains.fadeOut(direction, this.#hopFrames * Math.abs(playbackRate));
    return target;
  }

  /** Moves the time position on by `speed` samples; returns the next playhead position. */
  advance(active, playheadPosition, playbackRate, jumpTarget) {
    const nextPosition = jumpTarget ?? playheadPosition + playbackRate;
    if (!active) {
      this.reset(nextPosition);
      return nextPosition;
    }
    this.#timePosition += (playbackRate < 0 ? -1 : 1) * this.#speed;
    return nextPosition;
  }
}
