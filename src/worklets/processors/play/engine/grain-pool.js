// Grains are reads of the source. The current grain is the playhead. At an edge
// (wrap, turn, trim end) it hands off: an outgoing grain reads on from where the
// playhead was, in the direction it was going, and fades out, while the playhead
// relocates, or stops at the note's last edge. Outgoing grains nest: a newer one
// fades from what was audible when it started, older ones included, so overlapping
// edges stay continuous. Fade length and progress are in source samples, so a fade
// covers the same stretch of audio at any playback rate.
//
// Spawned grains are finite windowed reads (Hann fade-in, sustain, Hann fade-out)
// with their own rate ratio and stereo pan, summed alongside the playhead.

export const MAX_OUTGOING_GRAINS = 4; // reasonable: 2-16
export const MAX_SPAWNED_GRAINS = 7;
export const MAX_GRAINS = MAX_SPAWNED_GRAINS + 1;

// Symmetric Hann-tapered window: raised-cosine fade-in and fade-out, flat top in between.
function windowGain(age, length, fadeLength) {
  if (fadeLength <= 0) return 1;
  if (age < fadeLength) return 0.5 - 0.5 * Math.cos((Math.PI * age) / fadeLength);
  const remaining = length - age;
  if (remaining < fadeLength) return 0.5 - 0.5 * Math.cos((Math.PI * remaining) / fadeLength);
  return 1;
}

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
  // Active finite spawned grains. Unordered; preallocated and reused.
  #spawned = Array.from({ length: MAX_SPAWNED_GRAINS }, () => ({
    position: 0,
    direction: 1,
    rateRatio: 1,
    pan: 0,
    tailEnd: Infinity,
    length: 0,
    fadeLength: 0,
    age: 0,
    gain: 0,
  }));
  #spawnedCount = 0;

  /** Number of outgoing grains still fading. */
  get count() {
    return this.#count;
  }

  /** Number of finite spawned grains currently active. */
  get spawnedCount() {
    return this.#spawnedCount;
  }

  /** Nothing left to hear: the playhead has stopped and every grain has finished. */
  get isSilent() {
    return !this.current.active && this.#count === 0 && this.#spawnedCount === 0;
  }

  /**
   * Outgoing grain `i`, oldest first: its read `position`, its `tailEnd`,
   * and its `mix`, the weight of what plays inside it (0 when it starts, rising to 1).
   */
  outgoing(i) {
    return this.#outgoing[i];
  }

  /** Active spawned grain `i`: `position`, `rateRatio`, `pan`, `tailEnd`, and window `gain`. */
  spawned(i) {
    return this.#spawned[i];
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

  /**
   * Starts a finite windowed grain in the pool (Hann fade-in, sustain, Hann fade-out).
   * @param {number} position Starting source position in samples.
   * @param {1 | -1} direction Direction of travel.
   * @param {number} rateRatio Speed multiplier relative to the voice's rate.
   * @param {number} pan Pan offset in [-1, 1], added to the voice's pan.
   * @param {number} length Total duration in output frames.
   * @param {number} fadeLength Fade-in / fade-out length in output frames.
   * @param {number} [tailEnd=Infinity] Where the grain runs into silence, or Infinity.
   */
  spawn(position, direction, rateRatio, pan, length, fadeLength, tailEnd = Infinity) {
    if (length < 1 || this.#spawnedCount >= MAX_SPAWNED_GRAINS) return false;
    const grain = this.#spawned[this.#spawnedCount++];
    grain.position = position;
    grain.direction = direction;
    grain.rateRatio = rateRatio;
    grain.pan = pan;
    grain.tailEnd = tailEnd;
    grain.length = length;
    grain.fadeLength = Math.min(Math.max(0, fadeLength), length / 2);
    grain.age = 0;
    grain.gain = grain.fadeLength > 0 ? 0 : 1;
    return true;
  }

  /** Stops the playhead at the note's last edge; remaining grains finish fading. */
  endCurrent() {
    this.current.active = false;
  }

  /** Advances outgoing and spawned grains by one output frame at the voice's `speed`. */
  advance(speed) {
    for (let i = this.#count - 1; i >= 0; i--) {
      const grain = this.#outgoing[i];
      grain.position += grain.direction * speed;
      grain.progress += speed;
      if (grain.progress >= grain.length) this.#remove(i);
      else grain.mix = grain.progress / grain.length;
    }
    for (let i = this.#spawnedCount - 1; i >= 0; i--) {
      const grain = this.#spawned[i];
      grain.position += grain.direction * speed * grain.rateRatio;
      grain.age += 1;
      if (grain.age >= grain.length) this.#removeSpawned(i);
      else grain.gain = windowGain(grain.age, grain.length, grain.fadeLength);
    }
  }

  reset() {
    this.#count = 0;
    this.#spawnedCount = 0;
    this.current.active = true;
  }

  // Keeps order; the removed object moves past the live grains for reuse.
  #remove(i) {
    const grain = this.#outgoing[i];
    for (let j = i; j < this.#count - 1; j++) this.#outgoing[j] = this.#outgoing[j + 1];
    this.#outgoing[this.#count - 1] = grain;
    this.#count--;
  }

  // Order does not matter for additive grains; swap with last for reuse.
  #removeSpawned(i) {
    const last = this.#spawnedCount - 1;
    if (i !== last) {
      const grain = this.#spawned[i];
      this.#spawned[i] = this.#spawned[last];
      this.#spawned[last] = grain;
    }
    this.#spawnedCount--;
  }
}
