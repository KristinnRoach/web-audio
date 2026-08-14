import {
  NOTE_NAMES,
  ROOT_NOTES,
  NOTE_FREQUENCIES,
  NOTE_PERIODS,
  NOTE_NAMES_WITH_OCTAVE,
} from '../constants';
import { midiToFrequency, frequencyToMidi } from './core-utils';
import type { Note } from '../types';

export const findClosestNote = (freq: number) => {
  const closestNoteFreq = NOTE_FREQUENCIES.reduce((closest, current) =>
    Math.abs(current - freq) < Math.abs(closest - freq) ? current : closest
  );

  const closestMidiNote = frequencyToMidi(closestNoteFreq);

  const closestNoteInfo = createNoteFromMidi(closestMidiNote);

  return closestNoteInfo;
};

/**
 * Creates a complete Note object from a MIDI note number
 */
export function createNoteFromMidi(midiNote: number): Note {
  const frequency = midiToFrequency(midiNote);
  const octave = Math.floor(midiNote / 12) - 1; // MIDI note 0 is C-1
  const noteIndex = midiNote % 12;
  const name = NOTE_NAMES[noteIndex][0]; // Use first name (prefer sharps)

  return {
    name,
    octave,
    midiNote,
    frequency,
    period: 1 / frequency,
  };
}

/**
 * Gets the note name with octave for a given MIDI note number
 */
export function getNoteName(midiNote: number): string {
  const arrayIndex = midiNote;

  if (arrayIndex < 0 || arrayIndex >= NOTE_NAMES_WITH_OCTAVE.length) {
    throw new RangeError(`Invalid MIDI note: ${midiNote}`);
  }
  return NOTE_NAMES_WITH_OCTAVE[arrayIndex];
}

/**
 * Gets the MIDI note number for a given note name
 */
export function getMidiNote(noteName: string): number {
  const match = noteName.match(/^([A-G][#b]?)(\d+)$/);
  if (!match) {
    throw new Error(`Invalid note name format: ${noteName}`);
  }

  const [_, note, octaveStr] = match;
  const octave = parseInt(octaveStr, 10);
  const noteIndex = ROOT_NOTES[note as keyof typeof ROOT_NOTES];

  return (octave + 1) * 12 + noteIndex;
}

/**
 * Gets the frequency for a given note name
 */
export function getNoteFrequency(noteName: string): number {
  const midiNote = getMidiNote(noteName);
  return midiToFrequency(midiNote);
}

/**
 * Creates a map of note names to frequencies
 */
export function createNoteNameToFreqMap(): Record<string, number> {
  const result: Record<string, number> = {};

  NOTE_NAMES_WITH_OCTAVE.forEach((noteName, index) => {
    result[noteName] = NOTE_FREQUENCIES[index];
  });

  // Add enharmonic equivalents
  addEnharmonicEquivalents(result);

  // Sort the object by frequency values
  return sortObjectByValue(result);
}

// Helper function to add enharmonic equivalent notes
function addEnharmonicEquivalents(noteMap: Record<string, number>): void {
  // This function is already correct
  const enharmonicPairs = [
    ['C#', 'Db'],
    ['D#', 'Eb'],
    ['F#', 'Gb'],
    ['G#', 'Ab'],
    ['A#', 'Bb'],
  ];

  // For each octave where we have data
  for (let octave = 0; octave <= 8; octave++) {
    for (const [sharp, flat] of enharmonicPairs) {
      const sharpNote = `${sharp}${octave}`;
      const flatNote = `${flat}${octave}`;

      // If we have one but not the other, create the equivalent
      if (sharpNote in noteMap && !(flatNote in noteMap)) {
        noteMap[flatNote] = noteMap[sharpNote];
      } else if (flatNote in noteMap && !(sharpNote in noteMap)) {
        noteMap[sharpNote] = noteMap[flatNote];
      }
    }
  }
}

// Convert to array of entries, sort by value, and convert back to object
function sortObjectByValue(
  obj: Record<string, number>
): Record<string, number> {
  return Object.fromEntries(Object.entries(obj).sort((a, b) => a[1] - b[1]));
}

// Pre-computed maps for quick lookups
export const noteNameToFreq = createNoteNameToFreqMap();
export const noteNamesToPeriod = Object.fromEntries(
  Object.entries(noteNameToFreq).map(([note, freq]) => [note, 1 / freq])
) as Record<string, number>;
