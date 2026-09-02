import { clamp } from "../math/math-utils";
import { isCancelAndHoldSupported } from "./environment";

/**
 * Chromium workaround: cancelAndHoldAtTime on a partially-rendered
 * setValueCurveAtTime replays the curve from index 0 for one render quantum
 * (param dips to the curve start value -> audible click). Instead, cancel
 * everything and pin the param at a known value.
 *
 * holdValue must be captured BEFORE cancelScheduledValues runs, because
 * cancelling reverts param.value to its pre-curve value. Pass holdValue
 * explicitly whenever the caller knows the intended value.
 */
export function cancelAndPinParamValue(param: AudioParam, timestamp: number, holdValue?: number) {
  const value = holdValue ?? param.value; // read before cancel
  param.cancelScheduledValues(timestamp);
  param.setValueAtTime(value, timestamp);
}

export function cancelScheduledParamValues(
  param: AudioParam | AudioParam[],
  timestamp: number,
  holdValue?: number,
) {
  const paramsToProcess = Array.isArray(param) ? param : [param];

  paramsToProcess.forEach((p) => {
    if (isCancelAndHoldSupported()) {
      p.cancelAndHoldAtTime(timestamp);
    } else {
      p.cancelScheduledValues(timestamp);
      p.setValueAtTime(holdValue !== undefined ? holdValue : p.value, timestamp);
    }
  });
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
