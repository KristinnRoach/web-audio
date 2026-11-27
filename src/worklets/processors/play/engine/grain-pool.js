// Grains are reads of the source. The current grain is the playhead. At an edge
// (wrap, turn, trim end) it hands off: an outgoing grain reads on from where the
// playhead was, in the direction it was going, and fades out, while the playhead
// relocates, or stops at the note's last edge. Outgoing grains nest: a newer one
// fades from what was audible when it started, older ones included, so overlapping
// edges stay continuous. Fade length and progress are in source samples, so a fade
// covers the same stretch of audio at any playback rate.

export const MAX_OUTGOING_GRAINS = 4; // reasonable: 2-16

export class GrainPool {
  /**
   * The playhead. `active` is false once the note's last edge has faded it out;
   * it still moves, unheard, so the rest of the voice can keep its timing.
   */
  current = { position: 0, active: true };
  // Oldest first. Preallocated and reused: this runs on the audio thread.
  #outgoing = Array.from({ length: MAX_OUTGOING_GRAINS }, () => ({
    position: 0,
    direction: 1,
    tailEnd: Infinity,
    mix: 0,
    length: 0,
    progress: 0,
  }));
  #count = 0;

  /** Number of outgoing grains still fading. */
  get count() {
    return this.#count;
  }

  /** Nothing left to hear: the playhead has stopped and every outgoing grain has faded. */
  get isSilent() {
    return !this.current.active && this.#count === 0;
  }

  /**
   * Outgoing grain `i`, oldest first: its read `position`, its `tailEnd`,
   * and its `mix`, the weight of what plays inside it (0 when it starts, rising to 1).
   */
  outgoing(i) {
    return this.#outgoing[i];
  }

  /**
   * Starts an outgoing grain where the playhead is now. The caller then relocates
   * the playhead, or stops it with `endCurrent()`.
   * @param {1 | -1} direction The playhead's direction before the edge (differs
   *   from its next direction only for a turn).
   * @param {number} length Fade length in source samples.
   * @param {number} tailEnd Where that position's loop runs into silence, or Infinity.
   *   Trim can move during the fade; the grain keeps reading what was audible.
   */
  fadeOut(direction, length, tailEnd = Infinity) {
    if (length < 1) return;
    // ponytail: drops the oldest grain at the cap, a small step if it was still fading
    if (this.#count === MAX_OUTGOING_GRAINS) this.#remove(0);
    const grain = this.#outgoing[this.#count++];
    grain.position = this.current.position;
    grain.direction = direction;
    grain.tailEnd = tailEnd;
    grain.mix = 0;
    grain.length = length;
    grain.progress = 0;
  }

  /** Stops the playhead at the note's last edge; outgoing grains fade on. */
  endCurrent() {
    this.current.active = false;
  }

  /** Moves every outgoing grain on by the playhead's speed, each in its own direction. */
  advance(speed) {
    for (let i = this.#count - 1; i >= 0; i--) {
      const grain = this.#outgoing[i];
      grain.position += grain.direction * speed;
      grain.progress += speed;
      if (grain.progress >= grain.length) this.#remove(i);
      else grain.mix = grain.progress / grain.length;
    }
  }

  reset() {
    this.#count = 0;
    this.current.active = true;
  }

  // Keeps order; the removed object moves past the live grains for reuse.
  #remove(i) {
    const grain = this.#outgoing[i];
    for (let j = i; j < this.#count - 1; j++) this.#outgoing[j] = this.#outgoing[j + 1];
    this.#outgoing[this.#count - 1] = grain;
    this.#count--;
  }
}
