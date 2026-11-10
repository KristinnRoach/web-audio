function scaleExponential(value, semitoneOffset, depth) {
  return value * 2 ** ((semitoneOffset / 12) * depth);
}

function offsetLinear(value, semitoneOffset, depth) {
  return value + semitoneOffset * depth;
}

/**
 * Keytracks a value relative to a MIDI root note. Fractional notes support glide and detune.
 * Exponential depth: 1 doubles the value per 12 semitones; -1 halves it.
 * Linear depth: target units added per semitone. Depth 0 leaves the value unchanged.
 * Clamping and rounding belong to the target, not this helper.
 * @param {number} value
 * @param {number} midiNote
 * @param {{ rootNote?: number, depth?: number, mapping?: 'exponential' | 'linear' }} [options]
 */
export function getKeytrackedValue(
  value,
  midiNote,
  { rootNote = 60, depth = 1, mapping = 'exponential' } = {},
) {
  const semitoneOffset = midiNote - rootNote;
  switch (mapping) {
    case 'exponential':
      return scaleExponential(value, semitoneOffset, depth);
    case 'linear':
      return offsetLinear(value, semitoneOffset, depth);
    default:
      throw new RangeError(`Unknown keytracking mapping: ${String(mapping)}`);
  }
}
