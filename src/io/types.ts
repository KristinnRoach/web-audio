// src/input/types.ts

interface Keyboard {
  getLayoutMap(): Promise<Record<string, string>>;
  // [key: string]: any;
}

declare global {
  interface Navigator {
    keyboard?: Keyboard;
  }
}

export type ModifierKey = 'space' | 'caps' | 'meta' | 'shift' | 'ctrl' | 'alt';
// needed to add space and just simplified for flexibility for now by using string

export type PressedModifiers = Partial<Record<ModifierKey, boolean>>;

export interface InputHandler {
  onNoteOn: (
    midiNote: number,
    velocity: number,
    modifiers?: PressedModifiers
  ) => void;
  onNoteOff: (midiNote: number, modifiers: PressedModifiers) => void;
  onBlur: () => void;
  onModifierChange?: (modifiers: PressedModifiers) => void;
}

export type KeyMap = Record<string, number>;
