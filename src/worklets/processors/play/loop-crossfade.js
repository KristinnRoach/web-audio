// Crossfades playhead discontinuities (loop jumps and moves). Each one leaves an
// outgoing head reading on from where the playhead was, fading out while the
// relocated playhead fades in. Heads nest: a newer head fades from what was
// audible when it started, older heads included, so overlapping discontinuities
// stay continuous. Length and progress are in source samples, so a fade covers
// the same stretch of audio at any playback rate.

const MAX_HEADS = 4; // reasonable: 2-16

export class LoopCrossfade {
  // Oldest first. Preallocated and reused: this runs on the audio thread.
  #heads = Array.from({ length: MAX_HEADS }, () => ({
    position: 0,
    fadesTail: false,
    mix: 0,
    length: 0,
    progress: 0,
  }));
  #count = 0;

  /** Number of outgoing heads still fading. */
  get count() {
    return this.#count;
  }

  /**
   * Outgoing head `i`, oldest first: its read `position`, whether it `fadesTail`,
   * and its `mix`, the weight of what plays inside it (0 when it starts, rising to 1).
   */
  head(i) {
    return this.#heads[i];
  }

  /**
   * @param {number} position Where the playhead was before relocating.
   * @param {number} length Fade length in source samples.
   * @param {boolean} fadesTail Whether that position's loop has a silent tail.
   */
  start(position, length, fadesTail) {
    if (length < 1) return;
    // ponytail: drops the oldest head at the cap, a small step if it was still fading
    if (this.#count === MAX_HEADS) this.#remove(0);
    const head = this.#heads[this.#count++];
    head.position = position;
    head.fadesTail = fadesTail;
    head.mix = 0;
    head.length = length;
    head.progress = 0;
  }

  /** Moves every outgoing head along with the playhead's step. */
  advance(step) {
    for (let i = this.#count - 1; i >= 0; i--) {
      const head = this.#heads[i];
      head.position += step;
      head.progress += Math.abs(step);
      if (head.progress >= head.length) this.#remove(i);
      else head.mix = head.progress / head.length;
    }
  }

  reset() {
    this.#count = 0;
  }

  // Keeps order; the removed object moves past the live heads for reuse.
  #remove(i) {
    const head = this.#heads[i];
    for (let j = i; j < this.#count - 1; j++) this.#heads[j] = this.#heads[j + 1];
    this.#heads[this.#count - 1] = head;
    this.#count--;
  }
}
