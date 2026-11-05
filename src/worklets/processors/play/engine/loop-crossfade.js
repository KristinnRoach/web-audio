// Crossfades playhead discontinuities (loop jumps, turns and moves). Each one
// leaves an outgoing head reading on from where the playhead was, in the direction
// it was going, fading out while the relocated or turned playhead fades in. Heads
// nest: a newer head fades from what was audible when it started, older heads
// included, so overlapping discontinuities stay continuous. Length and progress are in source samples, so a fade covers
// the same stretch of audio at any playback rate.

export const MAX_OUTGOING_HEADS = 4; // reasonable: 2-16

export class LoopCrossfade {
  // Oldest first. Preallocated and reused: this runs on the audio thread.
  #heads = Array.from({ length: MAX_OUTGOING_HEADS }, () => ({
    position: 0,
    direction: 1,
    fadesTail: false,
    audioEnd: 0,
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
   * @param {1 | -1} direction Its direction before turning (differs from the
   *   playhead's only for a turn).
   * @param {number} length Fade length in source samples.
   * @param {boolean} fadesTail Whether that position's loop has a silent tail.
   * @param {number} audioEnd That position's trim end. Trim can move during the fade;
   *   the head keeps reading what was audible.
   */
  start(position, direction, length, fadesTail, audioEnd) {
    if (length < 1) return;
    // ponytail: drops the oldest head at the cap, a small step if it was still fading
    if (this.#count === MAX_OUTGOING_HEADS) this.#remove(0);
    const head = this.#heads[this.#count++];
    head.position = position;
    head.direction = direction;
    head.fadesTail = fadesTail;
    head.audioEnd = audioEnd;
    head.mix = 0;
    head.length = length;
    head.progress = 0;
  }

  /** Moves every outgoing head on by the playhead's speed, each in its own direction. */
  advance(speed) {
    for (let i = this.#count - 1; i >= 0; i--) {
      const head = this.#heads[i];
      head.position += head.direction * speed;
      head.progress += speed;
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
