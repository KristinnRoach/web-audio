// Audio-thread breakpoint envelope: walks an EnvelopeShape (see
// nodes/modulators/envelope/envelope-shape.ts) one sample at a time, as unitless
// values. Routing and units belong to voice-envelopes.js.
// ponytail: no sustain glide or loop restart bridge yet; a loop restart that cuts
// a pass mid-shape steps to point 0.

// Exponential segments can't start or end at zero, so they suit positive shapes only.
const MIN_EXP_VALUE = 1e-4;

export class BreakpointEnvelope {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Read at every segment start, so a new shape takes effect at the next point.
    this.shape = null;
    // Playback speed, read at every segment start like the shape. 2 plays twice as fast.
    this.timeScale = 1;
    this.value = 0;
    this.released = false;
    this.done = false;
    this.index = 0;
    this.remaining = 0;
    this.curve = 'linear';
    this.step = 0;
    this.target = 0;
  }

  trigger() {
    if (!this.shape) return;
    this.released = false;
    this.done = false;
    this.value = this.shape.points[0].value;
    this.#beginSegment(0);
  }

  /** Holds the current value, then plays the points after `releasePoint` at their spacing. */
  release() {
    if (!this.shape || this.released) return;
    this.released = true;
    this.#beginSegment(this.shape.releasePoint);
  }

  /** Value for the current sample, then advances one sample. */
  next() {
    const value = this.value;
    if (this.remaining > 0) {
      if (this.curve === 'exponential') this.value *= this.step;
      else if (this.curve === 'linear') this.value += this.step;
      if (--this.remaining === 0) {
        this.value = this.target;
        this.#beginSegment(this.index + 1);
      }
    }
    return value;
  }

  #beginSegment(index) {
    const { points, mode, sustainPoint } = this.shape;
    const last = points.length - 1;
    this.index = index;
    this.remaining = 0;

    if (index >= last) {
      if (mode.type === 'loop' && !this.released) {
        this.value = points[0].value;
        return this.#beginSegment(0);
      }
      this.done = this.released || mode.type === 'once';
      return;
    }
    // Hold until release.
    if (mode.type === 'sustain' && !this.released && index === sustainPoint) return;

    const from = points[index];
    const to = points[index + 1];
    const frames = Math.max(
      1,
      Math.round(((to.time - from.time) * this.sampleRate) / this.timeScale),
    );
    this.curve = from.curve ?? 'linear';
    this.target = to.value;
    this.remaining = frames;

    if (this.curve === 'exponential') {
      this.value = Math.max(this.value, MIN_EXP_VALUE);
      this.step = (Math.max(to.value, MIN_EXP_VALUE) / this.value) ** (1 / frames);
    } else {
      this.step = (to.value - this.value) / frames;
    }
  }
}
