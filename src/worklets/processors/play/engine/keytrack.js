// Keytracking for log-domain targets (pitch, frequency, time, length).

// A rate as octaves from the root. Given the note rate (glide included) it is the `key`
// source; given the sounding rate (pitch modulation included) it is `pitch`.
export function rateOctaves(rate) {
  return Math.log2(Math.abs(rate));
}

// `amount` is target octaves per key octave: 0 = fixed, 1 = follows the note, negative inverts.
export function trackOctaves(value, amount, key) {
  return value * 2 ** (amount * key);
}
