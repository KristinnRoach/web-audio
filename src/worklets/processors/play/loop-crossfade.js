// Crossfade for a loop jump: after the playhead jumps to the other loop edge,
// an outgoing head keeps reading on from the edge it left, fading out while the
// jumped playhead fades in. Length and progress are in source samples, so the
// fade covers the same stretch of audio at any playback rate.

export class LoopCrossfade {
  /** Outgoing read position in source samples, or null when idle. */
  outgoingPosition = null;
  #length = 0;
  #progress = 0;

  /**
   * @param {number} outgoingPosition Where the playhead was before the jump.
   * @param {number} length Fade length in source samples.
   */
  start(outgoingPosition, length) {
    if (length < 1) return this.reset();
    this.outgoingPosition = outgoingPosition;
    this.#length = length;
    this.#progress = 0;
  }

  /** Weight of the jumped playhead: 0 at the jump, rising to 1. */
  get mix() {
    return this.outgoingPosition === null ? 1 : this.#progress / this.#length;
  }

  /** Moves the outgoing head along with the playhead's step. */
  advance(step) {
    if (this.outgoingPosition === null) return;
    this.outgoingPosition += step;
    this.#progress += Math.abs(step);
    if (this.#progress >= this.#length) this.reset();
  }

  reset() {
    this.outgoingPosition = null;
    this.#length = 0;
    this.#progress = 0;
  }
}
