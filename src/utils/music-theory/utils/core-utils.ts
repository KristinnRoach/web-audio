// Core utility functions that don't depend on other modules

/**
 * Converts a MIDI note number to frequency in Hz
 */
export function midiToFrequency(midiNote: number, a4Frequency = 440): number {
  return a4Frequency * Math.pow(2, (midiNote - 69) / 12);
}

// /**
//  * Converts a frequency in Hz to a MIDI note number
//  */
export function frequencyToMidi(
  frequency: number,
  quantize: 'semitones' | 'scale' | 'none' = 'semitones',
  referenceFreq = 440,
  scale?: number[] // [0, 2, 4, 5, 7, 9, 11] for major scale
): number {
  const midiFloat = 12 * Math.log2(frequency / referenceFreq) + 69;

  if (quantize === 'scale' && scale) {
    const octave = Math.floor(midiFloat / 12);
    const semitone = ((midiFloat % 12) + 12) % 12; // Handle negative

    // Find closest scale degree
    const closest = scale.reduce((prev, curr) =>
      Math.abs(curr - semitone) < Math.abs(prev - semitone) ? curr : prev
    );

    return octave * 12 + closest;
  }

  return quantize === 'semitones' ? Math.round(midiFloat) : midiFloat;
}

/**
 * Generates frequencies for all notes in the specified range
 */
export function generateNoteFrequencies(
  startOctave = 0,
  endOctave = 9,
  a4Frequency = 440,
  precision = 4
): number[] {
  const frequencies: number[] = [];
  const semitoneRatio = Math.pow(2, 1 / 12);
  const a4Index = 4 * 12 + 9;

  for (
    let i = startOctave * 12;
    i <= endOctave * 12 + (endOctave === 8 ? 0 : 11);
    i++
  ) {
    const frequency = a4Frequency * Math.pow(semitoneRatio, i - a4Index);
    frequencies.push(Number(frequency.toFixed(precision)));
  }

  return frequencies;
}

/**
 * Convert frequency ratio to playback rate
 * @param targetFreq - Target frequency in Hz
 * @param sourceFreq - Source/reference frequency in Hz (default: 440Hz = A4)
 * @returns Playback rate multiplier
 */
export function frequencyToPlaybackRate(
  targetFreq: number,
  sourceFreq: number
): number {
  if (sourceFreq <= 0 || targetFreq <= 0) return 1;
  return targetFreq / sourceFreq;
}

/**
 * Convert playback rate back to frequency
 * @param playbackRate - Playback rate multiplier
 * @param sourceFreq - Source/reference frequency in Hz (default: 440Hz = A4)
 * @returns Target frequency in Hz
 */
export function playbackRateToFrequency(
  playbackRate: number,
  sourceFreq: number = 440
): number {
  return playbackRate * sourceFreq;
}

/**
 * Validates if a number is a valid MIDI value (0-127)
 */
export function isMidiValue(value?: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 127
  );
}

/**
 * Converts a MIDI note to a playback rate relative to a base note
 */
export function midiToPlaybackRate(
  midiNote: number,
  baseNote: number = 60
): number {
  return Math.pow(2, (midiNote - baseNote) / 12);
}

/**
 * Converts a MIDI note to a detune value in cents relative to a base note
 */
export function midiToDetune(midiNote: number, baseNote: number = 60): number {
  return (midiNote - baseNote) * 100;
}

/**
 * Normalizes a MIDI value (0-127) to a range of 0-1
 */
export function normalizeMidi(midiValue: number): number {
  return midiValue / 127;
}

/**
 * Converts a normalized value (0-1) to a MIDI value (0-127)
 */
export function denormalizeMidi(normalizedValue: number): number {
  return Math.round(normalizedValue * 127);
}
