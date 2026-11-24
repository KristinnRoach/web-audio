// The Rust breakpoint envelope behind the interface of engine/breakpoint-envelope.js,
// plus render() for a whole block. No AudioWorklet globals.

const CURVES = { linear: 0, exponential: 1, step: 2 };
const MODES = { once: 0, sustain: 1, loop: 2 };

/**
 * `bytes` is breakpoint_envelope.wasm. Synchronous, so it also works in an
 * AudioWorkletProcessor constructor, where there is no fetch.
 */
export function instantiateEnvelopeWasm(bytes) {
  return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
}

export class WasmBreakpointEnvelope {
  #wasm;
  #env;
  #shape = null;
  #timeScale = 1;
  #out = new Float32Array(0);

  constructor(wasm, sampleRate) {
    this.#wasm = wasm;
    this.#env = wasm.env_new(sampleRate);
  }

  get shape() {
    return this.#shape;
  }

  set shape(shape) {
    const wasm = this.#wasm;
    this.#shape = shape;
    if (!shape) {
      wasm.env_set_shape(this.#env, 0, 0, 0, 0);
      return;
    }
    if (shape.points.length > wasm.env_max_points())
      throw new RangeError(`Envelope has more than ${wasm.env_max_points()} points`);
    // ponytail: allocates a view per shape edit; keep one if edits arrive at audio rate.
    const points = new Float64Array(
      wasm.memory.buffer,
      wasm.env_points(this.#env),
      shape.points.length * 3,
    );
    shape.points.forEach(({ time, value, curve = 'linear' }, i) => {
      points.set([time, value, CURVES[curve]], i * 3);
    });
    wasm.env_set_shape(
      this.#env,
      shape.points.length,
      MODES[shape.mode.type],
      shape.sustainPoint,
      shape.releasePoint,
    );
  }

  get timeScale() {
    return this.#timeScale;
  }

  set timeScale(timeScale) {
    this.#timeScale = timeScale;
    this.#wasm.env_set_time_scale(this.#env, timeScale);
  }

  get released() {
    return !!this.#wasm.env_released(this.#env);
  }

  get done() {
    return !!this.#wasm.env_done(this.#env);
  }

  trigger() {
    this.#wasm.env_trigger(this.#env);
  }

  release() {
    this.#wasm.env_release(this.#env);
  }

  retarget() {
    this.#wasm.env_retarget(this.#env);
  }

  next() {
    return this.#wasm.env_next(this.#env);
  }

  /** Renders `frames` samples (at most env_max_frames) and returns a view of them in WASM memory. */
  render(frames) {
    const wasm = this.#wasm;
    wasm.env_render(this.#env, frames);
    // A later env_new can grow the memory, which detaches earlier views.
    if (this.#out.buffer !== wasm.memory.buffer) {
      this.#out = new Float32Array(
        wasm.memory.buffer,
        wasm.env_out(this.#env),
        wasm.env_max_frames(),
      );
    }
    return this.#out;
  }
}
