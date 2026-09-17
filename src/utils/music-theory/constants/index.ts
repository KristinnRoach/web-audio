import * as Notes from './notes';
import * as Scales from './scales';
import * as Midi from './midi';

import { generateNoteFrequencies } from '../utils/core-utils';

// Generate frequency and period data
const FREQUENCIES = generateNoteFrequencies(0, 9);
const PERIODS = FREQUENCIES.map((freq) => 1 / freq);

// Create note names with octaves
const NAMES_W_OCT = Array.from({ length: FREQUENCIES.length }, (_, i) => {
  const octave = Math.floor(i / 12) - 1;
  const noteIndex = i % 12;
  const noteName = Notes.NAMES[noteIndex][0]; // Use first name (prefer sharps)
  return `${noteName}${octave}`;
});

// Export everything with consistent naming
export const NOTE_NAMES = Notes.NAMES;
export const ROOT_NOTES = Notes.ROOTS;
export const NOTE_FREQUENCIES = FREQUENCIES;
export const NOTE_PERIODS = PERIODS;
export const NOTE_NAMES_WITH_OCTAVE = NAMES_W_OCT;
export const SCALE_PATTERNS = Scales.SCALES;
export const MIDI_MIDDLE_C = Midi.MIDDLE_C;
export const MIDI_DEFAULT_VELOCITY = Midi.DEFAULT_VELOCITY;
