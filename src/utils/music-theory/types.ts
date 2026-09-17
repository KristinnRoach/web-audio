/**
 * Represents a musical note with all its properties
 */
export type Note = {
  name: string; // Note name (e.g., "C", "F#")
  octave: number; // Octave number
  midiNote: number; // MIDI note number
  frequency: number; // Frequency in Hz
  period: number; // Period in seconds
};

/**
 * Represents a musical scale with all its properties
 */
export type Scale = {
  rootIdx: number; // Root note index (0-11, where 0 is C)
  frequencies: number[]; // Array of frequencies for all notes in the scale
  periodsInSec: number[]; // Array of periods for all notes in the scale
  scalePattern: number[]; // Array of semitone intervals from the root
  noteNames: string[]; // Array of note names in the scale
};

/**
 * Type for note root names (C, C#, Db, etc.)
 */
export type NoteRoot = keyof typeof import('./constants/notes').ROOTS;
