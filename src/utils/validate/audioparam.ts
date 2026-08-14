import { isCancelAndHoldSupported } from './environment';

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
export function cancelAndPinParamValue(
  param: AudioParam,
  timestamp: number,
  holdValue?: number
) {
  const value = holdValue ?? param.value; // read before cancel
  param.cancelScheduledValues(timestamp);
  param.setValueAtTime(value, timestamp);
}

export function cancelScheduledParamValues(
  param: AudioParam | AudioParam[],
  timestamp: number,
  holdValue?: number
) {
  const paramsToProcess = Array.isArray(param) ? param : [param];

  paramsToProcess.forEach((p) => {
    if (isCancelAndHoldSupported()) {
      p.cancelAndHoldAtTime(timestamp);
    } else {
      p.cancelScheduledValues(timestamp);
      p.setValueAtTime(
        holdValue !== undefined ? holdValue : p.value,
        timestamp
      );
    }
  });
}
