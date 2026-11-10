// Keytracking for log-domain targets (pitch, frequency, time, length).

// The `key` source: the played note's distance from the root, in octaves. Takes the
// note's playback rate, glide included, before any pitch modulation.
export function keyOctaves(noteRate) {
  return Math.log2(Math.abs(noteRate));
}

// `amount` is target octaves per key octave: 0 = fixed, 1 = follows the note, negative inverts.
export function trackOctaves(value, amount, key) {
  return value * 2 ** (amount * key);
}
