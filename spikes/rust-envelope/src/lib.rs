//! Rust port of `engine/breakpoint-envelope.js`, built to WASM with no dependencies.
//!
//! The JS `EnvelopeShape` object arrives flattened: JS writes `[time, value, curve]`
//! per point into `env_points()`, then calls `env_set_shape()` with the rest as
//! numbers. `env_render()` fills `env_out()` with one block.
//!
//! State is f64 like the JS version, so long exponential segments drift the same way.

const MAX_POINTS: usize = 32;
const MAX_FRAMES: usize = 128;
const POINT_FIELDS: usize = 3;

// Exponential segments can't start or end at zero, so they suit positive shapes only.
const MIN_EXP_VALUE: f64 = 1e-4;

// Curve codes. Anything else is a step: hold, then jump at the next point.
const LINEAR: f64 = 0.0;
const EXPONENTIAL: f64 = 1.0;

// Mode codes.
const ONCE: u32 = 0;
const SUSTAIN: u32 = 1;
const LOOP: u32 = 2;

pub struct Envelope {
    points: [f64; MAX_POINTS * POINT_FIELDS],
    out: [f32; MAX_FRAMES],
    count: usize,
    mode: u32,
    sustain_point: usize,
    release_point: usize,
    sample_rate: f64,
    time_scale: f64,
    value: f64,
    released: bool,
    done: bool,
    index: usize,
    remaining: u32,
    curve: f64,
    step: f64,
    target: f64,
    holding: bool,
    hold_glide: f64,
}

impl Envelope {
    fn new(sample_rate: f64) -> Self {
        Envelope {
            points: [0.0; MAX_POINTS * POINT_FIELDS],
            out: [0.0; MAX_FRAMES],
            count: 0,
            mode: ONCE,
            sustain_point: 0,
            release_point: 0,
            sample_rate,
            time_scale: 1.0,
            value: 0.0,
            released: false,
            done: false,
            index: 0,
            remaining: 0,
            curve: LINEAR,
            step: 0.0,
            target: 0.0,
            holding: false,
            // Fixed ~10 ms glide, so sustain edits don't click.
            hold_glide: 1.0 - (-1.0 / (0.01 * sample_rate)).exp(),
        }
    }

    fn time(&self, index: usize) -> f64 {
        self.points[index * POINT_FIELDS]
    }

    fn point_value(&self, index: usize) -> f64 {
        self.points[index * POINT_FIELDS + 1]
    }

    fn point_curve(&self, index: usize) -> f64 {
        self.points[index * POINT_FIELDS + 2]
    }

    fn trigger(&mut self) {
        if self.count == 0 {
            return;
        }
        self.released = false;
        self.done = false;
        self.value = self.point_value(0);
        self.begin_segment(0);
    }

    fn release(&mut self) {
        if self.count == 0 || self.released {
            return;
        }
        self.released = true;
        self.begin_segment(self.release_point);
    }

    /// Aims the running segment at its end point's value in the current shape, keeping
    /// its remaining time and curve, so a value edit lands without a step.
    fn retarget(&mut self) {
        if self.remaining == 0 || self.index + 1 >= self.count {
            return;
        }
        self.target = self.point_value(self.index + 1);
        self.step = self.step_towards(self.target, self.remaining);
    }

    fn step_towards(&self, target: f64, frames: u32) -> f64 {
        if self.curve == EXPONENTIAL {
            (target.max(MIN_EXP_VALUE) / self.value).powf(1.0 / frames as f64)
        } else {
            (target - self.value) / frames as f64
        }
    }

    /// Value for the current sample, then advances one sample.
    fn next(&mut self) -> f64 {
        let value = self.value;
        if self.holding && self.index < self.count {
            self.value += (self.point_value(self.index) - self.value) * self.hold_glide;
        }
        if self.remaining > 0 {
            if self.curve == EXPONENTIAL {
                self.value *= self.step;
            } else if self.curve == LINEAR {
                self.value += self.step;
            }
            self.remaining -= 1;
            if self.remaining == 0 {
                self.value = self.target;
                self.begin_segment(self.index + 1);
            }
        }
        value
    }

    fn begin_segment(&mut self, mut index: usize) {
        let last = self.count.saturating_sub(1);
        self.index = index;
        self.remaining = 0;
        self.holding = false;

        if index >= last {
            if self.mode == LOOP && !self.released && last > 0 {
                self.value = self.point_value(0);
                index = 0;
                self.index = 0;
            } else {
                self.done = self.released || self.mode == ONCE;
                return;
            }
        }
        // Hold until release.
        if self.mode == SUSTAIN && !self.released && index == self.sustain_point {
            self.holding = true;
            return;
        }

        let seconds = self.time(index + 1) - self.time(index);
        let frames = ((seconds * self.sample_rate / self.time_scale).round() as u32).max(1);
        self.curve = self.point_curve(index);
        self.target = self.point_value(index + 1);
        self.remaining = frames;
        if self.curve == EXPONENTIAL {
            self.value = self.value.max(MIN_EXP_VALUE);
        }
        self.step = self.step_towards(self.target, frames);
    }
}

// --- WASM boundary: an envelope is a pointer JS holds on to. ---

// ponytail: never freed; a voice pool lives as long as its processor. Add env_free
// if envelopes ever come and go.
#[no_mangle]
pub extern "C" fn env_new(sample_rate: f64) -> *mut Envelope {
    Box::into_raw(Box::new(Envelope::new(sample_rate)))
}

/// Where JS writes `[time, value, curve]` per point, up to `env_max_points()`.
#[no_mangle]
pub unsafe extern "C" fn env_points(env: *mut Envelope) -> *mut f64 {
    (*env).points.as_mut_ptr()
}

/// Where `env_render` leaves its block.
#[no_mangle]
pub unsafe extern "C" fn env_out(env: *mut Envelope) -> *const f32 {
    (*env).out.as_ptr()
}

#[no_mangle]
pub extern "C" fn env_max_points() -> u32 {
    MAX_POINTS as u32
}

#[no_mangle]
pub extern "C" fn env_max_frames() -> u32 {
    MAX_FRAMES as u32
}

/// Call after writing the points. Like the JS version, a running segment keeps its
/// time and curve until the next point; `count` 0 clears the shape.
#[no_mangle]
pub unsafe extern "C" fn env_set_shape(
    env: *mut Envelope,
    count: u32,
    mode: u32,
    sustain_point: u32,
    release_point: u32,
) {
    let env = &mut *env;
    env.count = (count as usize).min(MAX_POINTS);
    env.mode = mode;
    env.sustain_point = sustain_point as usize;
    env.release_point = release_point as usize;
}

#[no_mangle]
pub unsafe extern "C" fn env_set_time_scale(env: *mut Envelope, time_scale: f64) {
    (*env).time_scale = time_scale;
}

#[no_mangle]
pub unsafe extern "C" fn env_trigger(env: *mut Envelope) {
    (*env).trigger();
}

#[no_mangle]
pub unsafe extern "C" fn env_release(env: *mut Envelope) {
    (*env).release();
}

#[no_mangle]
pub unsafe extern "C" fn env_retarget(env: *mut Envelope) {
    (*env).retarget();
}

#[no_mangle]
pub unsafe extern "C" fn env_released(env: *const Envelope) -> u32 {
    (*env).released as u32
}

#[no_mangle]
pub unsafe extern "C" fn env_done(env: *const Envelope) -> u32 {
    (*env).done as u32
}

/// One sample per call, as the JS engine consumes it today.
#[no_mangle]
pub unsafe extern "C" fn env_next(env: *mut Envelope) -> f64 {
    (*env).next()
}

/// Fills the first `frames` samples of `env_out()`.
#[no_mangle]
pub unsafe extern "C" fn env_render(env: *mut Envelope, frames: u32) {
    let env = &mut *env;
    for i in 0..(frames as usize).min(MAX_FRAMES) {
        env.out[i] = env.next() as f32;
    }
}
