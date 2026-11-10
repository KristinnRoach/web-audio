// Keytracking for log-domain targets (pitch, frequency, time, length).

// A rate as octaves from the root. Given the note rate (glide included) it is the `key`
// source; given the sounding rate (pitch modulation included) it is `pitch`.
export function rateOctaves(rate) {
  return Math.log2(Math.abs(rate));
}

// `amount` is target octaves per source octave: 0 = fixed, 1 = follows the source, negative inverts.
export function trackOctaves(value, amount, octaves) {
  return value * 2 ** (amount * octaves);
}
