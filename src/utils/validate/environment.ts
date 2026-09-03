// Empty import to import the Keyboard interface from input/types
import {} from "../../io/types";

type AudioEnvironment = {
  readonly workletSupported: boolean;
  readonly keyboardAPISupported: boolean;
  readonly modifierStateSupported: boolean;
} | null;

class Environment {
  #capabilities: AudioEnvironment = null;

  constructor() {
    try {
      if (typeof window === "undefined" || typeof AudioContext === "undefined") {
        console.error(`Environment util: Window or AudioContext is undefined`);
        return;
      }

      // Audio capabilities
      const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextConstructor();

      // Keyboard capabilities
      const hasKeyboardAPI = typeof navigator !== "undefined" && "keyboard" in navigator;
      const hasModifierState =
        typeof KeyboardEvent !== "undefined" &&
        typeof KeyboardEvent.prototype.getModifierState === "function";

      this.#capabilities = {
        workletSupported: typeof ctx.audioWorklet === "object",
        keyboardAPISupported: hasKeyboardAPI,
        modifierStateSupported: hasModifierState,
      };

      ctx.close().catch(console.error);
    } catch {
      // Fallback for test environment
      this.#capabilities = {
        workletSupported: false,
        keyboardAPISupported: false,
        modifierStateSupported: false,
      };
    }
  }

  get capabilities(): AudioEnvironment {
    return this.#capabilities;
  }
}

// Singleton instance
export const environment = new Environment();

// Convenience getters
export const isWorkletSupported = () => !!environment?.capabilities?.workletSupported;
export const isKeyboardAPISupported = () => !!environment?.capabilities?.keyboardAPISupported;
export const isModifierStateSupported = () => !!environment?.capabilities?.modifierStateSupported;
