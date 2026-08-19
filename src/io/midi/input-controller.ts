import { WebMidi } from "webmidi";

/**
 * MIDI Input Controller - Clean, Flexible API
 *
 * Supports multiple target types for maximum convenience:
 * - Knob elements (auto-detects setValueNormalized/setValue methods)
 * - Simple callback functions
 * - Objects with setValue method
 * - Objects with onControlChange method
 *
 * ControlChangeEvent provides both value formats:
 * - event.normalizedValue: 0-1 range (default, most common)
 * - event.midiValue: 0-127 range (raw MIDI spec)
 *
 * @example
 * // Knobs - automatically calls the right method
 * inputController.registerControlTarget(knobElement, { controller: 15 });
 *
 * @example
 * // Simple callback - cleanest for custom logic
 * inputController.registerControlTarget(
 *   (value, event) => console.log(`CC${event.controller}: ${value}`),
 *   { controller: 15 }
 * );
 *
 * @example
 * // Raw MIDI values instead of normalized
 * inputController.registerControlTarget(knob, {
 *   controller: 15,
 *   transformValue: (event) => event.midiValue
 * });
 */

export type NoteEvent = {
  type: "noteon" | "noteoff";
  note: number;
  velocity: number;
  channel: number;
  raw: any;
};

export type ControlChangeEvent = {
  type: "controlchange";
  controller: number;
  normalizedValue: number; // 0-1 (WebMidi convenience)
  midiValue: number; // 0-127 (raw MIDI spec)
  channel: number;
  raw: any;
};

// Add sustain pedal support to InputController
export type SustainPedalEvent = {
  type: "sustainpedal";
  pressed: boolean;
  channel: number;
  raw: any;
};

type NoteHandler = (event: NoteEvent) => void;
type ControlChangeHandler = (event: ControlChangeEvent) => void;
type SustainPedalHandler = (event: SustainPedalEvent) => void;

export type NoteTarget = {
  play: (note: number, velocity?: number) => void;
  release: (note: number) => void;
};

// Simple control target - just needs setValue
export type SimpleControlTarget = {
  setValue: (value: number) => void;
};

// Knob-like control target - supports common knob methods
export type KnobControlTarget = {
  setValueNormalized?: (value: number) => void;
  setValue?: (value: number) => void;
};

// Detailed control target - needs full event data
export type DetailedControlTarget = {
  onControlChange: (value: number, event: ControlChangeEvent) => void;
};

// Function callback - simplest form
export type ControlCallback = (value: number, event: ControlChangeEvent) => void;

// Union type for flexibility
export type ControlTarget =
  | SimpleControlTarget
  | KnobControlTarget
  | DetailedControlTarget
  | ControlCallback;

export type SustainPedalTarget = {
  setSustainPedal: (pressed: boolean) => void;
};

type RegisterControlOptions = {
  controller: number | number[];
  channel?: number | "all";
  transformValue?: (event: ControlChangeEvent) => number;
};

/**
 * Check if Web MIDI API is supported in the current browser
 */
export function isMidiSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
}

/**
 * Get browser-specific MIDI support information
 */
export function getMidiSupportInfo(): {
  supported: boolean;
  browserName: string;
  message: string;
} {
  const userAgent = navigator.userAgent;
  const isChrome = /Chrome/.test(userAgent) && /Google Inc/.test(navigator.vendor || "");
  const isEdge = /Edg/.test(userAgent);
  const isOpera = /OPR/.test(userAgent);
  const isSafari = /Safari/.test(userAgent) && !/Chrome/.test(userAgent);
  const isFirefox = /Firefox/.test(userAgent);

  let browserName = "Unknown";
  if (isChrome) browserName = "Chrome";
  else if (isEdge) browserName = "Edge";
  else if (isOpera) browserName = "Opera";
  else if (isSafari) browserName = "Safari";
  else if (isFirefox) browserName = "Firefox";

  const supported = isMidiSupported();

  let message = "";
  if (!supported) {
    if (isSafari) {
      message =
        "Safari doesn't support Web MIDI API. Use Chrome, Edge, or Opera for MIDI functionality.";
    } else if (isFirefox) {
      message =
        "Firefox has limited Web MIDI API support. Use Chrome, Edge, or Opera for full MIDI functionality.";
    } else {
      message = "Web MIDI API not supported in this browser.";
    }
  }

  return { supported, browserName, message };
}

export class InputController {
  #initialized = false;
  #noteOnHandlers = new Set<NoteHandler>();
  #noteOffHandlers = new Set<NoteHandler>();
  #controlChangeHandlers = new Set<ControlChangeHandler>();
  #sustainPedalHandlers = new Set<SustainPedalHandler>();

  async init(): Promise<boolean> {
    if (this.#initialized) return true;

    // Check if Web MIDI API is supported before attempting to enable
    if (!isMidiSupported()) {
      const { browserName, message } = getMidiSupportInfo();
      console.warn(`InputController: ${message} (Browser: ${browserName})`);
      return false;
    }

    try {
      await WebMidi.enable();
    } catch (error) {
      console.warn("InputController: WebMIDI enable failed", error);
      return false;
    }

    if (!WebMidi.enabled) {
      console.warn("InputController: WebMIDI not enabled");
      return false;
    }

    this.#initialized = true;
    this.#attachToInputs();
    return true;
  }

  onNoteOn(handler: NoteHandler): () => void {
    this.#noteOnHandlers.add(handler);
    return () => this.#noteOnHandlers.delete(handler);
  }

  onNoteOff(handler: NoteHandler): () => void {
    this.#noteOffHandlers.add(handler);
    return () => this.#noteOffHandlers.delete(handler);
  }

  onControlChange(handler: ControlChangeHandler): () => void {
    this.#controlChangeHandlers.add(handler);
    return () => this.#controlChangeHandlers.delete(handler);
  }

  onSustainPedal(handler: SustainPedalHandler): () => void {
    this.#sustainPedalHandlers.add(handler);
    return () => this.#sustainPedalHandlers.delete(handler);
  }

  registerNoteTarget(target: NoteTarget, channel: number | "all" = "all"): () => void {
    const noteOnUnsub = this.onNoteOn((event) => {
      if (!this.#matchesChannel(channel, event.channel)) return;
      target.play(event.note, event.velocity ?? 0);
    });

    const noteOffUnsub = this.onNoteOff((event) => {
      if (!this.#matchesChannel(channel, event.channel)) return;
      target.release(event.note);
    });

    return () => {
      noteOnUnsub();
      noteOffUnsub();
    };
  }

  /**
   * Register one or more control targets to respond to MIDI CC messages.
   *
   * By default, passes normalized values (0-1) to targets. Use transformValue for custom behavior.
   *
   * Supports multiple target types for maximum flexibility:
   *
   * @example
   * // Knobs - automatically calls setValueNormalized if available
   * inputController.registerControlTarget(knobElement, { controller: 15 });
   *
   * @example
   * // Simple callback function - cleanest for custom logic
   * inputController.registerControlTarget(
   *   (value, event) => console.log(`CC${event.controller}: ${value}`),
   *   { controller: 15 }
   * );
   *
   * @example
   * // Multiple targets controlled by same CC
   * inputController.registerControlTarget([knob1, knob2], { controller: 15 });
   *
   * @example
   * // Raw MIDI values (0-127) instead of normalized (0-1)
   * inputController.registerControlTarget(knobElement, {
   *   controller: 15,
   *   transformValue: (event) => event.midiValue
   * });
   *
   * @example
   * // Object with setValue method (sliders, etc.)
   * inputController.registerControlTarget({ setValue: (v) => slider.value = v }, { controller: 15 });
   */
  registerControlTarget(
    target: ControlTarget | ControlTarget[],
    options: RegisterControlOptions,
  ): () => void {
    const targets = Array.isArray(target) ? target : [target];
    const controllers = Array.isArray(options.controller)
      ? options.controller
      : [options.controller];
    const channel = options.channel ?? "all";

    // By default, pass normalized values (0-1) - most common use case
    const transformValue =
      options.transformValue ?? ((event: ControlChangeEvent) => event.normalizedValue);

    const unsubscribe = this.onControlChange((event) => {
      if (!controllers.includes(event.controller)) return;
      if (!this.#matchesChannel(channel, event.channel)) return;

      const value = transformValue(event);

      targets.forEach((t) => {
        if (typeof t === "function") {
          // Function callback - simplest form
          t(value, event);
        } else if ("onControlChange" in t) {
          // Detailed control target
          t.onControlChange(value, event);
        } else if ("setValueNormalized" in t && t.setValueNormalized) {
          // Knob-like target with setValueNormalized
          t.setValueNormalized(value);
        } else if ("setValue" in t && t.setValue) {
          // Simple control target with setValue
          t.setValue(value);
        }
      });
    });

    return unsubscribe;
  }

  registerSustainPedalTarget(
    target: SustainPedalTarget,
    channel: number | "all" = "all",
  ): () => void {
    const unsubscribe = this.onSustainPedal((event) => {
      if (!this.#matchesChannel(channel, event.channel)) return;
      target.setSustainPedal(event.pressed);
    });

    return unsubscribe;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get midiSupported(): boolean {
    return isMidiSupported();
  }

  get supportInfo() {
    return getMidiSupportInfo();
  }

  #attachToInputs(): void {
    WebMidi.inputs.forEach((input) => {
      if (!input) return;

      input.addListener("noteon", (event: any) => {
        this.#emit(this.#noteOnHandlers, event, "noteon");
      });

      input.addListener("noteoff", (event: any) => {
        this.#emit(this.#noteOffHandlers, event, "noteoff");
      });

      // Add sustain pedal listener (CC64)
      input.addListener("controlchange", (event: any) => {
        const controller = event.controller?.number ?? event.controller?.value ?? 0;

        // Handle sustain pedal (CC64) specially
        if (controller === 64) {
          this.#emitSustainPedal(event);
        } else {
          this.#emitControlChange(event);
        }
      });
    });
  }

  #emit(handlers: Set<NoteHandler>, event: any, type: "noteon" | "noteoff") {
    if (!handlers.size) return;

    const payload: NoteEvent = {
      type,
      note: event.note?.number ?? 0,
      velocity:
        event.note?.rawAttack ??
        (typeof event.velocity === "number" ? event.velocity : (event.note?.attack ?? 0)),
      channel: event.message?.channel ?? 1,
      raw: event,
    };

    handlers.forEach((handler) => handler(payload));
  }

  #emitControlChange(event: any) {
    if (!this.#controlChangeHandlers.size) return;

    const payload: ControlChangeEvent = {
      type: "controlchange",
      controller:
        event.controller?.number ??
        event.controller?.value ??
        (typeof event.controller === "number" ? event.controller : 0),
      // Provide both values explicitly
      normalizedValue:
        typeof event.value === "number"
          ? event.value
          : typeof event.rawValue === "number"
            ? event.rawValue / 127
            : 0,
      midiValue:
        typeof event.rawValue === "number"
          ? event.rawValue
          : typeof event.value === "number"
            ? Math.round(event.value * 127)
            : 0,
      channel: event.message?.channel ?? 1,
      raw: event,
    };

    this.#controlChangeHandlers.forEach((handler) => handler(payload));
  }

  #emitSustainPedal(event: any) {
    if (!this.#sustainPedalHandlers.size) return;

    const midiValue =
      typeof event.rawValue === "number"
        ? event.rawValue
        : typeof event.value === "number"
          ? Math.round(event.value * 127)
          : 0;

    const payload: SustainPedalEvent = {
      type: "sustainpedal",
      pressed: midiValue >= 64, // MIDI standard: >= 64 is "on"
      channel: event.message?.channel ?? 1,
      raw: event,
    };

    this.#sustainPedalHandlers.forEach((handler) => handler(payload));
  }

  #matchesChannel(target: number | "all", incoming: number | undefined) {
    if (target === "all") return true;
    if (typeof incoming !== "number") return false;
    return target === incoming;
  }
}

export const inputController = new InputController();
