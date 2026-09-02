import { clamp } from "../math/math-utils";

/**
 * Cancels scheduled automation and pins the param at a known value.
 *
 * Stands in for cancelAndHoldAtTime, which glitches on an already-rendering
 * setValueCurveAtTime in Chrome and is unimplemented in Firefox. Details and
 * measurements: https://github.com/KristinnRoach/web-audio/issues/33
 *
 * holdValue is read before cancelling on purpose - cancelling is allowed to
 * restore the pre-curve value. Pass it explicitly when the caller knows it.
 */
export function cancelAndPinParamValue(param: AudioParam, timestamp: number, holdValue?: number) {
  const value = holdValue ?? param.value; // read before cancel
  param.cancelScheduledValues(timestamp);
  param.setValueAtTime(value, timestamp);
}

/** Lowest cutoff worth setting on a filter. */
export const MIN_HZ = 20;

/** Fallback ceiling when no valid sample rate is available. */
export const FALLBACK_MAX_HZ = 20000;

/**
 * Highest cutoff that is safe to set for a given sample rate: Nyquist minus a
 * 1 kHz guard band. Falls back to 20 kHz without a usable sample rate.
 */
export function maxSafeHz(sampleRate?: number): number {
  return sampleRate && sampleRate > 0 ? sampleRate / 2 - 1000 : FALLBACK_MAX_HZ;
}

/** Clamps a filter cutoff into the safe range for a given sample rate. */
export function clampHz(hz: number, sampleRate?: number): number {
  return clamp(hz, MIN_HZ, maxSafeHz(sampleRate));
}
