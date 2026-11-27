// Crossfades playhead discontinuities: loop jumps and turns. (Pitch loop moves fade
// between windows in SamplePlayerVoice instead.) Each one leaves an outgoing head
// reading on from where the playhead was, in the direction it was going, fading out
// while the relocated or turned playhead fades in. Heads nest: a newer head fades
// from what was audible when it started, older heads included, so overlapping
// discontinuities stay continuous. Length and progress are in source samples, so a
// fade covers the same stretch of audio at any playback rate.

export const MAX_OUTGOING_HEADS = 4; // reasonable: 2-16

export class LoopCrossfade {
  // Oldest first. Preallocated and reused: this runs on the audio thread.
  #heads = Array.from({ length: MAX_OUTGOING_HEADS }, () => ({
    position: 0,
    direction: 1,
    tailEnd: Infinity,
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
   * Outgoing head `i`, oldest first: its read `position`, its `tailEnd`,
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
   * @param {number} tailEnd Where that position's loop runs into silence, or Infinity.
   *   Trim can move during the fade; the head keeps reading what was audible.
   */
  start(position, direction, length, tailEnd = Infinity) {
    if (length < 1) return;
    // ponytail: drops the oldest head at the cap, a small step if it was still fading
    if (this.#count === MAX_OUTGOING_HEADS) this.#remove(0);
    const head = this.#heads[this.#count++];
    head.position = position;
    head.direction = direction;
    head.tailEnd = tailEnd;
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

  /** Moves every head with a playhead carried by a moving pitch loop, which has no silent tail. */
  shift(delta) {
    for (let i = 0; i < this.#count; i++) {
      const head = this.#heads[i];
      head.position += delta;
      head.tailEnd = Infinity;
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
