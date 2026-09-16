import type { Envelope, EnvelopeCurve, ScheduleOptions } from "./Envelope";
import type { EnvelopeState, EnvelopeType } from "./env-types";

/**
 * Where a normalized envelope shape meets one concrete audio parameter.
 *
 * The scheduler in `Envelope.ts` only knows `param = base + amount * value`, which is
 * every parameter a linear depth suits: a gain scaled by velocity, a playback rate
 * scaled by the note's own rate. A cutoff is the exception. It is heard geometrically,
 * so a filter envelope has to travel geometrically from the resting cutoff up to the
 * filter's ceiling, and a linear depth would put nearly all of its motion at the top.
 *
 * That difference belongs here rather than in the scheduler. Mapping the point values
 * before they are scheduled keeps one scheduling core: the geometry lands in the
 * values, and the segments between them ride the exponential ramps the Web Audio API
 * already provides. `exp(a + (b - a) * t)` is exactly `exp(a) * (exp(b) / exp(a))^t`,
 * so a linear move through log-Hz and an exponential ramp between mapped endpoints are
 * the same curve. This is the mapping the old value-curve generator applied sample by
 * sample, done once per point instead.
 */
export type EnvelopeBinding = {
  envelope: Envelope;
  options: ScheduleOptions;
};

export type BindOptions = {
  /**
   * What the envelope is measured against. Velocity for an amp envelope, the note's
   * playback rate for a pitch envelope, the resting cutoff in Hz for a filter envelope.
   */
  baseValue: number;
  /** The voice's playback rate, used only when the state asks to follow it. */
  playbackRate: number;
  /** Top of the filter envelope's sweep. Ignored by every other envelope type. */
  ceiling?: number;
};

/** A cutoff cannot be zero or negative, and `log` of either is not a frequency. */
const MIN_CUTOFF_HZ = 1e-3;

/**
 * Geometric position between `from` and `to`, so 0 lands on `from` and 1 on `to`.
 * Point values outside [0, 1] extrapolate along the same curve rather than clamping,
 * which is what the value range is for.
 */
function geometric(from: number, to: number) {
  const low = Math.max(from, MIN_CUTOFF_HZ);
  const high = Math.max(to, low);
  const logLow = Math.log(low);
  const logRange = Math.log(high) - logLow;

  return (value: number) => Math.exp(logLow + logRange * value);
}

/**
 * Point times are divided by this, so a value above 1 plays the envelope faster.
 *
 * Following the sample's playback rate is the same knob rather than a second
 * mechanism: a note played an octave up runs at rate 2 and its envelope with it.
 */
function resolveTimeScale(state: EnvelopeState, playbackRate: number) {
  const scale = state.timeScale * (state.playbackRateSync ? playbackRate : 1);
  // Zero or NaN would collapse every point onto one instant, or onto none at all.
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * Resolves a stored envelope state against one parameter and one note.
 *
 * ponytail: no clamping to the parameter's range. `AudioParam` already clamps every
 * computed value to `[minValue, maxValue]`, so the old explicit clamp only duplicated
 * it. Drop this note if a parameter ever needs to be clamped somewhere other than its
 * own nominal range.
 */
export function bindEnvelope(
  state: EnvelopeState,
  envelopeType: EnvelopeType,
  { baseValue, playbackRate, ceiling }: BindOptions,
): EnvelopeBinding {
  const { points, sustainIndex, releaseIndex } = state.shape;
  const timeScale = resolveTimeScale(state, playbackRate);

  if (envelopeType === "filter-env") {
    const toHz = geometric(baseValue, ceiling ?? baseValue);
    // Forced exponential: the values are already in Hz, and only a geometric segment
    // between them reproduces a straight line through log-Hz. A linear ramp here
    // would crowd the whole sweep into the top of its range.
    const mapped = points.map((point) => ({
      time: point.time,
      value: toHz(point.value),
      curve: "exponential" as EnvelopeCurve,
    }));

    return {
      envelope: shapeOf(mapped, sustainIndex, releaseIndex, state.loop),
      options: { base: 0, amount: 1, timeScale },
    };
  }

  // Everything else is a straight depth: velocity scales a gain, the note's rate
  // scales a playback rate. Point values stay normalized so `amount` carries the
  // depth, which is also what keeps the exponential zero-floor proportional.
  return {
    envelope: shapeOf(points, sustainIndex, releaseIndex, state.loop),
    options: { base: 0, amount: baseValue, timeScale },
  };
}

/**
 * `loop` is only expressible alongside a `sustain`, since the sustain point is where
 * the loop ends. A stored state can still ask to loop without one, and it means the
 * whole shape repeats, so the last point stands in as the loop end.
 *
 * Without a loop, no sustain means the shape plays through on its own while the note
 * is held and the release stage is still its tail on note-off.
 */
function shapeOf(
  points: Envelope["points"],
  sustainIndex: number | null,
  releaseIndex: number,
  loop: boolean,
): Envelope {
  if (sustainIndex !== null) return { points, sustain: sustainIndex, release: releaseIndex, loop };
  if (loop && points.length > 1) {
    return { points, sustain: points.length - 1, release: releaseIndex, loop: true };
  }
  return { points, release: releaseIndex };
}
