// A voice's envelopes, one fixed slot per engine target, stepped on the processor
// clock. Configs follow the sampler's EnvelopeConfig, `{ shape, depth = 1,
// timeScale = 1, playbackRateSync, loopSync }`, plus `base = 0` and `negativeDepth = depth`
// (applied to negative shape values), in the target's units: gain for 'gain', cents for 'detune' and 'filter', -1..1 for 'pan'. A slot without a config is inactive
// and the engine falls back to the matching AudioParam.

import { BreakpointEnvelope } from './breakpoint-envelope.js';
import { glideCoefficient } from './loop-length.js';

export const ENVELOPE_TARGETS = ['gain', 'detune', 'pan', 'filter'];

// One-pole on every envelope output: rounds off vertical segments, step curves and
// loop-sync cuts. Also softens the fastest attack by about this much.
const SMOOTHING_SECONDS = 0.001;

class EnvelopeSlot {
  constructor(sampleRate) {
    this.envelope = new BreakpointEnvelope(sampleRate);
    this.config = null;
    this.triggerPending = false;
    this.smoothed = 0;
    // base + depth (or negativeDepth below 0) * smoothed envelope, in the target's units.
    // Read by the engine.
    this.value = 0;
  }

  get active() {
    return this.config !== null;
  }
}

export class VoiceEnvelopes {
  constructor(sampleRate) {
    this.smoothingCoefficient = glideCoefficient(SMOOTHING_SECONDS, sampleRate);
    this.gain = new EnvelopeSlot(sampleRate);
    this.detune = new EnvelopeSlot(sampleRate);
    this.pan = new EnvelopeSlot(sampleRate);
    // Not applied by the engine: rendered to a control output for the voice's filter.
    this.filter = new EnvelopeSlot(sampleRate);
    this.slots = [this.gain, this.detune, this.pan, this.filter];
    this.pendingReleaseFrame = null;
    this.noteRate = 1;
  }

  /**
   * A new shape's values apply now: the running segment re-aims and a held sustain
   * glides. Its times take effect at the next point; a running note keeps its trigger.
   */
  set(target, config) {
    if (!ENVELOPE_TARGETS.includes(target))
      throw new RangeError(`Unknown envelope target ${target}`);
    const slot = this[target];
    slot.config = config ?? null;
    slot.envelope.shape = config?.shape ?? null;
    slot.envelope.retarget();
  }

  /** Starts every active envelope on the next advance(); `noteRate` drives playbackRateSync. */
  trigger(noteRate = 1) {
    this.noteRate = noteRate;
    this.pendingReleaseFrame = null;
    // Inactive slots keep the trigger pending, so one enabled later in the note starts fresh.
    for (const slot of this.slots) slot.triggerPending = true;
  }

  release(frame) {
    this.pendingReleaseFrame = frame;
  }

  get releasing() {
    return this.pendingReleaseFrame !== null || this.gain.envelope.released;
  }

  /** The gain envelope has played out, so the note can end. */
  get gainDone() {
    return this.gain.active && this.gain.envelope.done;
  }

  /**
   * Steps every active envelope one sample. `loopWindow` is the last resolved loop
   * (null before the note's first), `loopWrapped` true on the sample after a wrap.
   */
  advance(frame, playbackRate, loopEnabled, loopWrapped, loopWindow, bufferLength) {
    const released = this.pendingReleaseFrame !== null && frame >= this.pendingReleaseFrame;
    if (released) this.pendingReleaseFrame = null;

    for (const slot of this.slots) {
      if (!slot.active) continue;
      const { envelope, config } = slot;
      if (released) envelope.release();

      // Loop sync fits the full buffer to one sample loop, restarting at each wrap.
      const loopSync =
        config.loopSync && loopEnabled && config.shape.mode.type === 'loop' && !envelope.released;
      const restart = slot.triggerPending || (loopWrapped && loopSync);

      if (restart && loopSync && !loopWindow) {
        // Wait one sample for the loop length; hold the opening value meanwhile.
        slot.smoothed = config.shape.points[0].value;
      } else {
        // Each new segment uses current timing. Loop sync follows the sounding rate;
        // playbackRateSync follows the note's own rate.
        envelope.timeScale =
          (config.timeScale ?? 1) *
          (loopSync && loopWindow.length > 0
            ? (bufferLength * Math.abs(playbackRate)) / loopWindow.length
            : config.playbackRateSync
              ? Math.abs(this.noteRate)
              : 1);
        if (restart) {
          // A new note starts on the shape; only loop-sync restarts glide from the old value.
          if (slot.triggerPending) slot.smoothed = config.shape.points[0].value;
          slot.triggerPending = false;
          envelope.trigger();
        }
        slot.smoothed += (envelope.next() - slot.smoothed) * this.smoothingCoefficient;
      }
      const depth = config.depth ?? 1;
      slot.value =
        (config.base ?? 0) +
        (slot.smoothed < 0 ? (config.negativeDepth ?? depth) : depth) * slot.smoothed;
    }
  }
}
