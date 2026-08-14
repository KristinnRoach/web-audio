/**  UTILITY FUNCTIONS  */

/**
 * Calculate frequency value with A4 = 440Hz
 * @param midiNote MIDI note number (A4 = 69)
 * @returns Frequency in Hz
 */
export function midiToFreq(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Simple wave shaper function to add harmonics
 * @param sample Input sample (-1 to 1)
 * @param amount Amount of distortion (0 to 1)
 * @returns Processed sample
 */
export function softClip(sample: number, amount: number = 0): number {
  // If amount is 0, return the original sample
  if (amount === 0) return sample;

  // Simple tanh-based soft clipper
  return Math.tanh(sample * (1 + amount * 3));
}

export function generateSineWave(phase: number, amplitude: number): number {
  return amplitude * Math.sin(2 * Math.PI * phase);
}

// Function to advance oscillator phase
export function advancePhase(
  currentPhase: number,
  frequency: number,
  sampleRate: number
): number {
  // Calculate phase increment for a full sine wave cycle
  let newPhase = currentPhase + frequency / sampleRate;

  // Keep phase in 0-1 range (one full cycle)
  if (newPhase >= 1) {
    newPhase -= Math.floor(newPhase);
  }

  return newPhase;
}
