// One voice's playback state and rendering, free of AudioWorklet globals. The caller
// passes in the sample rate, block position and random source; messages go out through
// `post`, synchronously, in the order they occur.

import { findNearestZeroCrossing } from '@/worklets/shared/utils/findNearestZeroCrossing.js';
import { PeriodLockStretcher } from './period-lock-stretch.js';
import { reflectLoopPosition, wrapLoopPosition } from './loop-edges.js';
import { LoopCrossfade, MAX_OUTGOING_HEADS } from './loop-crossfade.js';
import { LoopWindow } from './loop-window.js';
import { getKeytrackedValue } from './keytrack.js';
import { ClampedSourceReader } from './source-reader.js';
import { VoiceEnvelopes } from './voice-envelopes.js';
import { readSource, SincKernel } from './interpolation-kernels.js';
import {
  driftLoopEnd,
  driftRollInterval,
  glideCoefficient,
  glideToward,
  isInQuantizationRange,
  loopDriftSamples,
  quantizeLoopLength,
} from './loop-length.js';

const DEFAULT_PITCH_PRESERVATION_THRESHOLD_SECONDS = 1 / 32.703;
// Loop jump and turn crossfade length in source samples (~5 ms at 48 kHz).
const LOOP_CROSSFADE_SAMPLES = 256; // reasonable: 32 - 1024
// U-turn crossfade: a ping-pong or backward-loop turn has no step, but its slope
// reverses in one frame (a corner, audible at zero crossings). The crossfade
// rounds it off, at the cost of a brief level dip. Not standard sampler practice;
// false restores bare turns.
const LOOP_TURN_CROSSFADE = true;
// Pitch loop move crossfade, old window to new at the same phase. In output time,
// not source samples: it doesn't depend on the loop's length or the playback rate.
// Moves during a fade wait for it, so this is also the longest lag behind a drag.
// UI drags arrive as discrete jumps per pointer event (~60-120 Hz); the fade should
// span about one gap between them, or a drag steps. Tuned by ear: 10 ms stepped.
const LOOP_MOVE_FADE_SECONDS = 0.02; // reasonable: 0.005 - 0.05
// Source-domain fade into a loop's silence padding; not a note release.
const TAIL_FADE_SAMPLES = 64;
// Note-boundary de-click ramps, independent of pitch, direction and the musical
// amp envelope. Keep these in output frames; loop fades follow source position.
// Host stop: ~1.3 ms at 48 kHz.
const STOP_FADE_FRAMES = 64;
// Tiny opening ramp in output frames (~0.33 ms at 48 kHz).
const START_FADE_FRAMES = 16;
// Pan drift glide, so a new roll doesn't step the channel gains and click. Tune by ear.
const PAN_DRIFT_SMOOTHING_SECONDS = 0.02;
function tailGainAt(position, audioEndSamples) {
  return Math.max(0, Math.min(1, (audioEndSamples - position) / TAIL_FADE_SAMPLES));
}

/**
 * Resolves two raw points into an ordered range inside [lo, hi], at least
 * `minLength` long (or as long as the bounds allow). Points arrive raw from the
 * main thread, so either may be set first and they may be equal.
 */
// Reused result: callers read it immediately, and this runs per sample.
const resolvedRange = [0, 0];
function resolveRange(a, b, lo, hi, minLength) {
  let start = Math.min(Math.max(Math.min(a, b), lo), hi);
  let end = Math.min(Math.max(Math.max(a, b), lo), hi);
  if (end - start < minLength) {
    // Grow the end, then pull the start back if the end hit the upper bound
    end = Math.min(start + minLength, hi);
    start = Math.max(lo, end - minLength);
  }
  resolvedRange[0] = start;
  resolvedRange[1] = end;
  return resolvedRange;
}

// Whether `other` has the same value for every field of `fields`.
function hasSameValues(fields, other) {
  for (const key in fields) {
    if (fields[key] !== other[key]) return false;
  }
  return true;
}

function isApproachingLoopWindow(position, approachDirection, loopWindow) {
  return approachDirection > 0 ? position < loopWindow.start : position >= loopWindow.end;
}

export class VoiceEngine {
  /**
   * @param {Object} options
   * @param {number} options.sampleRate - Context sample rate
   * @param {() => number} options.random - Random values in [0, 1)
   * @param {(message: Object) => void} options.post - Receives outgoing messages
   */
  constructor({ sampleRate, random, post }) {
    this.sampleRate = sampleRate;
    this.loopMoveFadeFrames = Math.max(1, Math.round(LOOP_MOVE_FADE_SECONDS * sampleRate));
    this.random = random;
    this.post = post;

    // Only set properties that should persist across resets.
    this.buffer = null;

    this.loopEnabled = false;
    this.reversePlayback = false;
    // Note-on starts at the loop instead of trim while looping is on.
    this.startFromLoop = false;
    this.panDriftEnabled = true;
    this.panDriftCoefficient = glideCoefficient(PAN_DRIFT_SMOOTHING_SECONDS, sampleRate);

    this.reportPlaybackPosition = false;

    // Per-note values from voice:start. The playbackRate param multiplies noteRate.
    this.noteRate = 1;
    this.noteRateTarget = 1;
    this.noteRateCoefficient = 1;
    this.velocityGain = 1;
    // Retunes waiting for their frames (voice:setRate), in timestamp order.
    this.pendingRates = [];

    // Gain is unity unless its slot is active; detune adds to the param (see voice-envelopes.js).
    this.envelopes = new VoiceEnvelopes(sampleRate);
    /** @type {import('./interpolation-kernels.js').InterpolationMode} */
    this.interpolation = 'hermite';
    this.enableLoopCrossfade = true; // Crossfade between loop edges
    this.loopCrossfade = new LoopCrossfade();
    this.loopWindowSlots = [new LoopWindow(), new LoopWindow()];
    // The window a pitch loop's playhead follows while a move waits for the running move fade.
    this.heldLoopWindow = new LoopWindow();
    // Where the window a pitch loop move fades from reads, relative to the playhead
    // (old start - new start).
    this.loopMoveOffset = 0;
    // Ping-pong turns around at both loop edges and overrides loop edge order.
    this.loopPingPong = false;
    // Keytrack loop. Resampling: 0 = loop length fixed in samples (loop time shortens as you
    // play higher), 1 = real-time loop duration constant across notes. Period stretch loops on
    // a unit-rate timeline and mirrors that: 0 = constant loop time, 1 = loop time / playbackRate.
    this.keytrackLoopAmount = 0;
    // Reused during rendering to avoid allocating options per sample.
    this.loopKeytrackOptions = { rootNote: 60, depth: 0, mapping: 'exponential' };

    this.timestretch = new PeriodLockStretcher(sampleRate);

    // Glide time constant between quantized loop periods, not an arrival time
    // (~95% after 3x). 0 = stepped. Initial value matches samplerParams.loopLengthGlide.
    this.loopLengthGlideCoefficient = glideCoefficient(0.125, sampleRate);
    this.loopPositionGlideCoefficient = glideCoefficient(0, sampleRate);

    // Reused per block and per sample, so rendering doesn't allocate.
    this.positionParams = {
      trimStartSamples: 0,
      trimEndSamples: 0,
      loopStartSamples: 0,
      loopEndSamples: 0,
    };
    this.trimRange = { startSamples: 0, endSamples: 0, inverted: false };
    this.previousRequestedLoop = { start: null, end: null };
    this.trimMessage = { type: 'trim:range', trimStart: 0, trimEnd: 0, inverted: false };
    this.loopMessage = { type: 'loop:range', loopStart: 0, loopEnd: 0, loopMode: 'forward' };
    this.positionMessage = { type: 'voice:position', position: 0 };
    // Everything sounding this sample: the playhead, the stretcher's outgoing head
    // and the crossfade heads.
    this.readHeads = Array.from({ length: MAX_OUTGOING_HEADS + 2 }, () => ({
      position: 0,
      gain: 1,
      mix: 0,
      source: new ClampedSourceReader(),
      sincKernel: new SincKernel(),
    }));
    this.readHeadCount = 0;
    this.idleLoopInputs = [];
    this.idleLoopKey = [];

    // Initialize all playback state
    this.reset();
  }

  // C5's wavelength, lowered to the shortest quantized target period so scales above C5 keep their pitch.
  get minRangeSamples() {
    return Math.min(this.sampleRate / 523.25, this.loopQuantizePeriods?.[0] ?? Infinity);
  }

  // Source-domain short-loop cutoff in samples, shared by musical loop policies.
  get pitchPreservationThreshold() {
    return (
      this.loopQuantizePeriods?.at(-1) ??
      Math.floor(this.sampleRate * DEFAULT_PITCH_PRESERVATION_THRESHOLD_SECONDS)
    );
  }

  // Rendering needs a note and a source; otherwise the voice is idle.
  get canRender() {
    return this.isPlaying && !!this.buffer?.[0]?.length;
  }

  // ===== CONTROLS =====

  setLoopQuantizePeriods(seconds) {
    // Seconds to samples, ascending: [0] is the shortest, at(-1) the longest.
    this.loopQuantizePeriods = seconds
      .map((value) => value * this.sampleRate)
      .sort((a, b) => a - b);
  }

  setBuffer(buffer) {
    this.reset();
    for (const head of this.readHeads) head.source.samples = null;
    this.zeroCrossings = [];
    this.timestretch.setPeriods(null, 1);
    this.buffer = buffer ?? null;
  }

  setZeroCrossings(zeroCrossings) {
    this.zeroCrossings = (zeroCrossings || []).map((timeSec) => timeSec * this.sampleRate);
  }

  setPitchPeriods(periods, hopSamples) {
    this.timestretch.setPeriods(periods, hopSamples);
  }

  /**
   * `note.playbackRate` is the note's rate, gliding there from `glideFrom` over
   * `glideSeconds` (a time constant, as setTargetAtTime). `velocity` is 0-127.
   */
  start(triggerId, timestamp, note = {}) {
    const { playbackRate = 1, velocity = 127, glideFrom, glideSeconds = 0 } = note;
    this.noteRateTarget = playbackRate;
    this.noteRate = glideSeconds > 0 && glideFrom !== undefined ? glideFrom : playbackRate;
    this.noteRateCoefficient = glideCoefficient(glideSeconds, this.sampleRate);
    this.pendingRates.length = 0;
    this.velocityGain = Math.max(0, Math.min(1, velocity / 127));

    this.isPlaying = true;
    this.triggerId = triggerId;
    this.#resetNoteLoop();
    this.postedRanges = {}; // each note posts its first resolved range

    // Set from the trim range on the first audible block
    this.playbackPosition = 0;
    this.needsStartPosition = true;

    // Frame this note should sound at. A timestamp that has already passed
    // by the time the message arrives starts the note now.
    this.pendingStartFrame = timestamp ? Math.round(timestamp * this.sampleRate) : 0;
    this.startFadeFrames = 0;
    this.#clearStop(); // a new note supersedes the previous note's stop
    // Envelopes start on the note's first audible sample.
    this.envelopes.trigger(playbackRate);
  }

  /** Retunes the sounding note at `timestamp`, gliding with a `glideSeconds` time constant. */
  setNoteRate(timestamp, playbackRate, glideSeconds = 0) {
    this.pendingRates.push({
      frame: timestamp ? Math.round(timestamp * this.sampleRate) : 0,
      rate: playbackRate,
      coefficient: glideCoefficient(glideSeconds, this.sampleRate),
    });
    this.pendingRates.sort((a, b) => a.frame - b.frame);
  }

  /** Routes an envelope config to 'gain' or 'detune', or null to follow that param. */
  setEnvelope(target, config) {
    // Without a gain envelope a pending or running release would never end the note.
    const endsRelease = target === 'gain' && !config && this.envelopes.gain.active;
    if (endsRelease && this.isPlaying && this.envelopes.releasing) this.stop(0);
    this.envelopes.set(target, config);
  }

  /** Releases the envelopes at `timestamp`; the note ends when the gain tail does. */
  release(timestamp) {
    if (!this.envelopes.gain.active) return this.stop(timestamp);
    const frame = timestamp ? Math.round(timestamp * this.sampleRate) : 0;
    if (this.pendingStartFrame && frame <= this.pendingStartFrame) return this.stop(timestamp);
    this.envelopes.release(frame);
  }

  setPanDriftEnabled(enabled) {
    this.panDriftEnabled = enabled;
    if (!enabled) this.currentPanDrift = 0;
  }

  setLoopLengthGlide(seconds) {
    this.loopLengthGlideCoefficient = glideCoefficient(seconds, this.sampleRate);
  }

  setLoopPositionGlide(seconds) {
    this.loopPositionGlideCoefficient = glideCoefficient(seconds, this.sampleRate);
  }

  setKeytrackLoopAmount(amount) {
    this.keytrackLoopAmount = Math.max(0, Math.min(1, amount));
  }

  setTimestretchMode(mode) {
    this.timestretch.setEnabled(mode === 'period', this.playbackPosition);
  }

  // ===== METHODS =====

  reset() {
    this.isPlaying = false;
    this.pendingRates.length = 0;
    this.pendingStartFrame = 0;
    this.startFadeFrames = 0;
    this.#clearStop();
    this.triggerId = 0;

    this.previousApproachDirection = null;
    this.playbackPosition = 0;
    this.previousPlaybackPosition = 0;
    this.needsStartPosition = false;
    this.#resetNoteLoop();
    this.timestretch.reset();
  }

  // Loop state each note starts from.
  #resetNoteLoop() {
    // True while cycling a loop against the approach direction (backward loops,
    // or the return half of a ping-pong). Direction = approach, negated when turned.
    this.loopTurned = false;
    this.loopCount = 0;
    this.loopWrapped = false;
    this.loopWindow = null;
    this.loopRate = 1;
    this.loopCrossfade.reset();
    this.loopMoveFadeLeft = 0; // output frames left in the pitch loop move fade
    this.#resetLoopGlides(); // new notes start on the target range

    this.loopDriftRolled = false; // roll fresh drift for this note
    this.currentLoopDrift = 0;
    this.currentPanDrift = 0;
    this.smoothedPanDrift = 0;
  }

  #resetLoopGlides() {
    this.isLoopLengthGliding = false;
    this.glidedLoopLogLength = null;
    this.isLoopPositionGliding = false;
    this.isLoopStartClamped = false;
    this.glidedLoopStart = null;
    // Raw loop edges in samples (start may pass end), from the last range calculation.
    this.previousRequestedLoop.start = null;
    this.previousRequestedLoop.end = null;
  }

  /**
   * Fades out from the frame of `timestamp`, then ends the note. A passed (or
   * missing) timestamp fades from the next rendered frame; a stop at or before
   * a pending start ends the note silently.
   */
  stop(timestamp) {
    const frame = timestamp ? Math.round(timestamp * this.sampleRate) : 0;
    if (this.pendingStartFrame && frame <= this.pendingStartFrame) return this.#halt();
    // The earliest stop wins, and a fade already under way keeps its progress.
    this.pendingStopFrame = Math.min(this.pendingStopFrame ?? Infinity, frame);
  }

  #clearStop() {
    this.envelopes.pendingReleaseFrame = null;
    this.pendingStopFrame = null;
    this.stopFadeFrames = 0;
  }

  // Every note that ends, by stop or at the playback boundary, reports it once.
  #halt() {
    this.post({ type: 'voice:ended', triggerId: this.triggerId });
    this.isPlaying = false;
    this.pendingRates.length = 0;
    this.pendingStartFrame = 0;
    this.#clearStop();
    this.playbackPosition = 0;
    this.needsStartPosition = false;
  }

  // Capped to a fraction of the loop, so short loops get short fades
  #crossfadeLength(loopWindow) {
    return Math.min(LOOP_CROSSFADE_SAMPLES, loopWindow.length / 4);
  }

  /**
   * Moves the playhead past the loop edge it has reached, if any: jumps to the
   * other edge, or turns around. Turning is what makes a loop backward (turn
   * once on arrival, then jump) or ping-pong (turn at every edge). A loop mode
   * change takes effect at the next edge, so direction never flips mid-loop.
   */
  #passLoopEdge(approachDirection, loopWindow, tailEnd, timestretchActive) {
    const direction = this.loopTurned ? -approachDirection : approachDirection;
    const { start: loopStart, end: loopEnd } = loopWindow;
    const turns = this.loopPingPong || this.loopTurned !== loopWindow.direction < 0;
    // Stretch changes the read rate, while loop duration follows the unit-rate transport.
    const position = timestretchActive ? this.timestretch.timelinePosition : this.playbackPosition;
    const nextPosition = turns
      ? reflectLoopPosition(position, direction, loopStart, loopEnd)
      : wrapLoopPosition(position, direction, loopStart, loopEnd);
    if (nextPosition === null) return;

    if (turns) this.loopTurned = !this.loopTurned;
    if (this.enableLoopCrossfade && (!turns || LOOP_TURN_CROSSFADE)) {
      // The outgoing head carries on past the edge in the pre-turn direction
      const length = this.#crossfadeLength(loopWindow);
      this.loopCrossfade.start(this.playbackPosition, direction, length, tailEnd);
    }
    this.playbackPosition = nextPosition;
    if (timestretchActive) this.timestretch.reset(nextPosition);
    this.loopCount++;
    this.loopWrapped = true;

    // Reset drift flag to generate new drift for next loop iteration
    this.loopDriftRolled = false;
  }

  // A pitch loop's length is its pitch. The playhead is in source coordinates, so
  // a moving window would shift its phase every sample and bend the cycles while
  // it moves. Carry the playhead with the window start instead.
  //
  // Moves latch, as in Faust's de.sdelay: a move crossfades from the old window to the
  // new one at the same phase (the whole head mix, read at both), and moves that
  // arrive during that fade wait for it to end, then take up the latest start in one
  // fade. A drag runs one move fade at a time instead of stacking a fade per sample.
  // Meanwhile the playhead follows the held window: the new length and direction at
  // the old start, so pitch still follows the loop per sample.
  // Returns the window the playhead follows.
  #carryPlayhead(window, direction, trimRange) {
    const previous = this.loopWindow;
    this.loopWindow = window;
    if (
      !previous ||
      window.start === previous.start ||
      !this.loopEnabled ||
      !window.isPitchLoop ||
      this.previousPlaybackPosition < previous.start ||
      this.previousPlaybackPosition > previous.end
    ) {
      return window;
    }
    const fades =
      this.enableLoopCrossfade && (!this.isLoopPositionGliding || this.isLoopStartClamped);
    if (fades && this.loopMoveFadeLeft > 0) {
      const heldStart = previous.start; // read first: previous may be the held window
      // Bounded by the buffer, not trim: a trim drag pushes the loop too, and its moves
      // wait like any other. A move can't wait when the new length pushes the held window
      // past the buffer, or leaves the playhead traveling toward it from past the trim end
      // (the note would end).
      const held = this.heldLoopWindow;
      held.start = heldStart;
      held.length = window.length;
      held.direction = window.direction;
      held.isPitchLoop = true;
      const position = this.playbackPosition;
      const leftTrim =
        direction > 0 ? position >= trimRange.endSamples : position < trimRange.startSamples;
      if (
        held.end <= this.buffer[0].length &&
        !(leftTrim && isApproachingLoopWindow(position, direction, held))
      ) {
        this.loopWindow = held;
        return held;
      }
    }
    const delta = window.start - previous.start;
    if (fades) {
      // ponytail: a move that can't wait drops a running fade's older window, a small
      // step if it was still audible.
      this.loopMoveFadeLeft = this.loopMoveFadeFrames;
      this.loopMoveOffset = 0;
    }
    // Running wrap and turn fades move with the playhead, and the offset reads all
    // of them back in the window a running move fade started from.
    this.loopMoveOffset -= delta;
    this.loopCrossfade.shift(delta);
    this.playbackPosition += delta;
    return window;
  }

  #isWithin(window) {
    return this.playbackPosition >= window.start && this.playbackPosition <= window.end;
  }

  #addReadHead(position, gain, mix) {
    const head = this.readHeads[this.readHeadCount++];
    head.position = position;
    head.gain = gain;
    head.mix = mix;
  }

  // Innermost first. The stretcher's head stays inside the crossfade heads even when
  // it started later; among those, the newest is innermost, since each fades from
  // what was audible when it started. They keep their own tail gain, so the silent
  // tail can't mute the outgoing side of a reverse wrap.
  #collectReadHeads(tailGain) {
    this.readHeadCount = 0;
    this.#addReadHead(this.playbackPosition, tailGain, 0);
    if (this.timestretch.outgoingPosition !== null) {
      this.#addReadHead(this.timestretch.outgoingPosition, tailGain, this.timestretch.crossfadeMix);
    }
    const crossfade = this.loopCrossfade;
    for (let i = crossfade.count - 1; i >= 0; i--) {
      const { position, tailEnd, mix } = crossfade.head(i);
      this.#addReadHead(position, tailGainAt(position, tailEnd), mix);
    }
  }

  // Each head's `mix` is the weight of the heads inside it. The innermost has
  // nothing inside it, so its 0 leaves it at full level. All heads move at `rate`.
  // `offset` reads every head in the window a move fades from.
  #mixReadHeads(channel, rate, offset = 0) {
    let mixed = 0;
    for (let i = 0; i < this.readHeadCount; i++) {
      const { source, sincKernel, position, gain, mix } = this.readHeads[i];
      // Mono sources feed every output channel.
      source.samples = this.buffer[Math.min(channel, this.buffer.length - 1)];
      const value =
        readSource(this.interpolation, source, position + offset, rate, sincKernel) * gain;
      mixed = value + mix * (mixed - value);
    }
    return mixed;
  }

  #findNearestZeroCrossing(position, direction = 'any', maxDistance = null) {
    return findNearestZeroCrossing(this.zeroCrossings, position, direction, maxDistance);
  }

  // ===== CONVERSION UTILITIES =====

  /**
   * Convert sample index to a fraction of the buffer length
   * @param {number} sampleIndex - Sample index
   * @returns {number} - Fraction of the buffer length
   */
  #samplesToNormalized(sampleIndex) {
    if (!this.buffer || !this.buffer[0]) return 0;
    return sampleIndex / this.buffer[0].length;
  }

  /**
   * Extract and convert all position parameters from seconds to samples
   * @param {Object} parameters - AudioWorkletProcessor parameters
   * @param {number} sample - Frame in the block to read them at
   * @returns {Object} - Converted parameters in samples, a reused object
   */
  #extractPositionParams(parameters, sample = 0) {
    const samples = this.positionParams;
    const { trimStart, trimEnd, loopStart, loopEnd } = parameters;
    // Keep edges fractional: a short range's length is its pitch, and flooring
    // rounded it to whole source samples (~5 cents at a C5-length loop). Playback
    // position and interpolation are already fractional; every consumer that
    // needs an index rounds locally.
    samples.trimStartSamples = this.#getSafeParam(trimStart, sample) * this.sampleRate;
    samples.trimEndSamples = this.#getSafeParam(trimEnd, sample) * this.sampleRate;
    samples.loopStartSamples = this.#getSafeParam(loopStart, sample) * this.sampleRate;
    samples.loopEndSamples = this.#getSafeParam(loopEnd, sample) * this.sampleRate;
    return samples;
  }

  // Trim and time loop edges snap inward to zero crossings, unless that would take the
  // range below the pitch cutoff: a short range keeps its length, which is its pitch.
  // Directional searches clamp to the outermost crossing, which can be outward.
  #snapStart(start, end) {
    const snapped = this.#findNearestZeroCrossing(start, 'right');
    return snapped >= start && end - snapped > this.pitchPreservationThreshold ? snapped : start;
  }

  #snapEnd(start, end) {
    const snapped = this.#findNearestZeroCrossing(end, 'left');
    return snapped <= end && snapped - start > this.pitchPreservationThreshold ? snapped : end;
  }

  /**
   * Calculate effective trim range in samples
   * @param {Object} params - Position parameters from #extractPositionParams
   * @returns {Object} - Effective start and end positions, a reused object
   */
  #calculateTrimRange(params) {
    const bufferLength = this.buffer?.[0]?.length || 0;
    // Loop points never move trim. Start past end plays the range backward.
    const resolved = resolveRange(
      params.trimStartSamples,
      params.trimEndSamples,
      0,
      bufferLength,
      this.minRangeSamples,
    );
    const start = this.#snapStart(resolved[0], resolved[1]);
    const end = this.#snapEnd(start, resolved[1]);

    const range = this.trimRange;
    range.startSamples = start;
    range.endSamples = end;
    range.inverted = params.trimStartSamples > params.trimEndSamples;
    return range;
  }

  // One-pole glide in the log domain (even pitch glide), once per audible sample.
  // Only inside the quantization range; outside it, or entering it, the length jumps.
  #glideLoopLength(target) {
    this.isLoopLengthGliding = false;
    if (!isInQuantizationRange(target, this.loopQuantizePeriods)) {
      this.glidedLoopLogLength = null;
      return target;
    }
    const logTarget = Math.log(target);
    if (this.glidedLoopLogLength === null) {
      this.glidedLoopLogLength = logTarget;
    } else {
      this.glidedLoopLogLength = glideToward(
        this.glidedLoopLogLength,
        logTarget,
        this.loopLengthGlideCoefficient,
        1e-12,
      );
      this.isLoopLengthGliding = this.glidedLoopLogLength !== logTarget;
    }
    // The log round trip can exceed the longest period by an ULP and bypass quantization.
    return Math.min(Math.exp(this.glidedLoopLogLength), this.loopQuantizePeriods.at(-1));
  }

  // Move the source window gradually; the playhead carry follows it.
  #glideLoopPosition(targetStart, params, length) {
    const requestedSpan = params.loopEndSamples - params.loopStartSamples;
    const previous = this.previousRequestedLoop;
    // Paired Float32 AudioParams lose precision when translated far into the buffer.
    const tolerance =
      Math.max(
        Math.abs(targetStart),
        Math.abs(this.glidedLoopStart ?? 0),
        Math.abs(requestedSpan),
        1,
      ) *
      2 ** -22;
    const lengthUnchanged = Math.abs(requestedSpan - (previous.end - previous.start)) <= tolerance;
    this.isLoopPositionGliding = false;
    if (
      !this.loopEnabled ||
      !lengthUnchanged ||
      !isInQuantizationRange(length, this.loopQuantizePeriods) ||
      this.glidedLoopStart === null ||
      this.loopPositionGlideCoefficient === 1
    ) {
      this.glidedLoopStart = targetStart;
      return targetStart;
    }
    this.glidedLoopStart = glideToward(
      this.glidedLoopStart,
      targetStart,
      this.loopPositionGlideCoefficient,
      1e-6,
    );
    this.isLoopPositionGliding = this.glidedLoopStart !== targetStart;
    return this.glidedLoopStart;
  }

  /**
   * Calculate effective loop range in samples with optional drift
   * @param {Object} params - Position parameters from #extractPositionParams
   * @param {Object} trimRange - Range from #calculateTrimRange
   * @param {number} driftAmount - Loop duration drift amount (0-1)
   * @param {number} playbackRate - Sounding playback rate, pitch modulation included
   * @returns {LoopWindow} - Resolved source window with drift applied.
   *   A reused object, valid until the call after next; copy it to keep it longer.
   */
  #calculateLoopWindow(params, trimRange, driftAmount = 0, playbackRate = 1) {
    const { startSamples: trimStart, endSamples: trimEnd } = trimRange;
    const trimLength = trimEnd - trimStart;
    const bufferLength = this.buffer[0].length;
    // An unset loop end (9999 s) means the buffer end.
    const a = Math.min(Math.max(params.loopStartSamples, 0), bufferLength);
    const b = Math.min(Math.max(params.loopEndSamples, 0), bufferLength);
    let calcLoopStart = Math.min(a, b);
    let calcLoopEnd = Math.max(a, b);

    // Loop type, decided once, from the requested length. Nothing below changes it:
    // not trim, quantize, keytrack, snap or drift.
    const isPitchLoop = calcLoopEnd - calcLoopStart <= this.pitchPreservationThreshold;

    if (isPitchLoop) {
      // Constrained to trim while keeping its quantized/glided length as long as it fits.
      // A zero-length loop (end dragged onto start) floors at minRangeSamples,
      // which quantization lifts to the shortest period when a scale is set.
      const targetLength = quantizeLoopLength(
        Math.max(this.minRangeSamples, calcLoopEnd - calcLoopStart),
        this.loopQuantizePeriods,
      );
      const glidedLength = this.#glideLoopLength(targetLength);
      const fittedLength = Math.min(glidedLength, trimLength);
      const maxStart = trimEnd - fittedLength;
      this.isLoopStartClamped = false;
      if (this.glidedLoopStart !== null) {
        const clamped = Math.min(Math.max(this.glidedLoopStart, trimStart), maxStart);
        // Trim pushed the glide: over a sample is a jump to crossfade.
        this.isLoopStartClamped = Math.abs(clamped - this.glidedLoopStart) > 1;
        this.glidedLoopStart = clamped;
      }
      calcLoopStart = this.#glideLoopPosition(
        Math.min(Math.max(calcLoopStart, trimStart), maxStart),
        params,
        glidedLength,
      );
      calcLoopEnd = calcLoopStart + fittedLength;
    } else {
      calcLoopStart = Math.min(Math.max(calcLoopStart, trimStart), trimEnd);
      calcLoopEnd = Math.min(Math.max(calcLoopEnd, trimStart), trimEnd);
      // Too little of it inside trim to be a time loop: loop the whole trim.
      if (calcLoopEnd - calcLoopStart <= this.pitchPreservationThreshold) {
        calcLoopStart = trimStart;
        calcLoopEnd = trimEnd;
      }
      // No glides; a loop that becomes a pitch loop glides its position from here.
      this.isLoopLengthGliding = false;
      this.glidedLoopLogLength = null;
      this.isLoopPositionGliding = false;
      this.glidedLoopStart = calcLoopStart;
    }
    this.previousRequestedLoop.start = params.loopStartSamples;
    this.previousRequestedLoop.end = params.loopEndSamples;

    let baseDuration = calcLoopEnd - calcLoopStart;

    const keytrackAmount = isPitchLoop ? 0 : this.keytrackLoopAmount;
    if (keytrackAmount > 0) {
      // Only time loops get here, so stretch applies whenever it is on.
      const isStretched = this.timestretch.isActive(true, false);
      const keytrackOptions = this.loopKeytrackOptions;
      keytrackOptions.depth = isStretched ? -keytrackAmount : keytrackAmount;
      // Sounding note from the rate, detune included; temporary, see docs/modulation/MIGRATION.md.
      const midiNote = keytrackOptions.rootNote + 12 * Math.log2(Math.abs(playbackRate));
      baseDuration = Math.max(
        1,
        Math.floor(getKeytrackedValue(baseDuration, midiNote, keytrackOptions)),
      );
      // Deliberately unclamped: a keytracked loop can be longer than the available audio
      // (above the root note when resampling, below it when stretched). The tail is padded
      // with silence in render() instead of collapsing to the buffer end.
      calcLoopEnd = calcLoopStart + baseDuration;
    }

    // Re-derive the duration after keytrack before drift sizes its minimum length.
    baseDuration = calcLoopEnd - calcLoopStart;

    // Only snap time loops: a pitch loop's length is its pitch. Up to trimEnd, so the start
    // can't snap into a keytracked loop's silent tail.
    if (!isPitchLoop) {
      calcLoopStart = this.#snapStart(calcLoopStart, Math.min(calcLoopEnd, trimEnd));
    }

    calcLoopEnd = this.#applyLoopDrift(
      calcLoopStart,
      calcLoopEnd,
      baseDuration,
      isPitchLoop,
      driftAmount,
      trimEnd,
    );

    // Snap the end last: drift moves the wrap point, so snapping before drift
    // leaves the actual loop end off a zero crossing -> discontinuity click.
    // Skip the snap when the end sits in the silent tail: zero crossings only exist
    // inside the buffer, so snapping there would erase the padding.
    if (!isPitchLoop && calcLoopEnd <= trimEnd) {
      calcLoopEnd = this.#snapEnd(calcLoopStart, calcLoopEnd);
    }

    // Two reused slots instead of a new object per sample: render() compares
    // against loopWindow, so write into whichever slot that isn't.
    const window =
      this.loopWindowSlots[0] === this.loopWindow
        ? this.loopWindowSlots[1]
        : this.loopWindowSlots[0];
    window.start = calcLoopStart;
    window.length = calcLoopEnd - calcLoopStart;
    window.isPitchLoop = isPitchLoop;
    return window;
  }

  #getSafeParam(paramArray, index, isConstant = paramArray.length === 1) {
    return isConstant ? paramArray[0] : paramArray[Math.min(index, paramArray.length - 1)];
  }

  #getConstantFlags(parameters) {
    this.constantFlags ??= {
      playbackRate: true,
      detune: true,
    };

    this.constantFlags.playbackRate = parameters.playbackRate.length === 1;
    this.constantFlags.detune = parameters.detune.length === 1;

    return this.constantFlags;
  }

  /**
   * Moves the loop end by the current iteration's drift, rolling it if needed.
   * @param {number} baseDuration - Loop duration in samples, before zero-crossing snaps
   * @returns {number} - Drifted loop end in samples
   */
  #applyLoopDrift(loopStart, loopEnd, baseDuration, isPitchLoop, driftAmount, playbackEnd) {
    if (driftAmount <= 0 || !this.loopEnabled) {
      this.currentPanDrift = 0;
      return loopEnd;
    }

    if (!this.loopDriftRolled) this.#rollLoopDrift(driftAmount, baseDuration, isPitchLoop);

    return driftLoopEnd(loopStart, loopEnd, baseDuration, this.currentLoopDrift, playbackEnd);
  }

  /** Runs once per loop iteration. Audio-rate loops re-roll less often. */
  #rollLoopDrift(driftAmount, baseDuration, isPitchLoop) {
    const updateInterval = driftRollInterval(baseDuration, this.pitchPreservationThreshold);

    if (this.loopCount % updateInterval === 0) {
      this.currentLoopDrift = loopDriftSamples(this.random(), driftAmount, baseDuration);
      // Pitch loop drift is scaled down and rounded to whole samples, often to nothing,
      // so pan rolls its own value there.
      const panDrift = isPitchLoop
        ? (this.random() - 0.5) * 2 * driftAmount
        : this.currentLoopDrift / baseDuration;
      this.currentPanDrift = this.panDriftEnabled && this.loopCount > 0 ? panDrift : 0;
    }

    this.loopDriftRolled = true;
  }

  /**
   * Posts display state (`loop:range`, `trim:range`, `voice:position`), tagged
   * with the current `triggerId`. Compared against the last posted message of
   * that type for this note, so a change skipped by the throttle (`interval`
   * seconds, ~30 Hz by default) is sent on a later block. Only a message actually
   * posted allocates; `fields` is reused by the caller.
   */
  #postRange(fields, blockTime, interval = 1 / 30) {
    this.postedRanges ??= {};
    const posted = this.postedRanges[fields.type];
    if (posted && hasSameValues(fields, posted.message)) return;
    if (blockTime - (posted?.time ?? -1) < interval) return;
    const message = { ...fields, triggerId: this.triggerId };
    this.postedRanges[fields.type] = { message, time: blockTime };
    this.post(message);
  }

  /**
   * Resolves the loop range while idle, so the voice knows the snapped loop length
   * before the next note triggers its envelopes. Recomputed only when an input changed,
   * at most every `interval` seconds; a change skipped by the throttle is sent on a
   * later block, since the key only updates when a report is posted. No drift and unit
   * rate: drift is rolled per note, and the voice only uses this for the steady loop length.
   */
  reportIdle(parameters, blockTime, interval = 1 / 30) {
    if (!this.buffer?.[0]?.length) return;
    if (blockTime - (this.idleLoopPostTime ?? -1) < interval) return;
    const key = this.idleLoopKey;
    const inputs = this.idleLoopInputs;
    inputs[0] = parameters.loopStart[0];
    inputs[1] = parameters.loopEnd[0];
    inputs[2] = parameters.trimStart[0];
    inputs[3] = parameters.trimEnd[0];
    inputs[4] = this.buffer;
    inputs[5] = this.zeroCrossings;
    inputs[6] = this.loopQuantizePeriods;
    inputs[7] = this.keytrackLoopAmount;
    let changed = false;
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i] !== key[i]) changed = true;
    }
    if (!changed) return;
    // The inputs become the key; the old key is the next call's scratch.
    this.idleLoopKey = inputs;
    this.idleLoopInputs = key;
    this.idleLoopPostTime = blockTime;

    const positionParams = this.#extractPositionParams(parameters);
    // A stopped note's glide must not leak in: the next note starts on the target length.
    this.#resetLoopGlides();
    const loopWindow = this.#calculateLoopWindow(
      positionParams,
      this.#calculateTrimRange(positionParams),
    );
    // Posted directly, not through #postRange: its dedup compares against ranges
    // posted before a buffer reload, while the voice has cleared its copy. The key
    // check already limits this to real changes.
    this.post({
      type: 'loop:range',
      loopStart: loopWindow.start / this.sampleRate,
      loopEnd: loopWindow.end / this.sampleRate,
      // Resolved at playback rate 1: the voice rescales the length by the note's playback rate.
      keytrackAmount: loopWindow.isPitchLoop ? 0 : this.keytrackLoopAmount,
      idle: true,
      triggerId: this.triggerId,
    });
  }

  // ===== RENDER =====

  /**
   * Renders one block into `outputChannels` (Float32Arrays cleared to zero), from
   * `blockFrame`/`blockTime`. Check `canRender` first; while it is false, call
   * `reportIdle()` instead.
   */
  render(outputChannels, parameters, blockFrame, blockTime, filterOutput) {
    const { sampleRate } = this;

    // ===== Scheduled start =====

    // Gate playback before any stateful preparation, such as loop-drift
    // generation, so silent lookahead blocks cannot change the first audible
    // block. Worklet output buffers start each render quantum cleared to zero.
    let startOffset = 0;
    if (this.pendingStartFrame > blockFrame) {
      startOffset = this.pendingStartFrame - blockFrame;
      // Whole quantum is before the note: stay silent, leave all state untouched.
      if (startOffset >= outputChannels[0].length) return;
    }
    this.pendingStartFrame = 0;

    // ===== GET PARAM VALUES =====

    const masterGain = parameters.masterGain[0];

    const positionParams = this.#extractPositionParams(parameters, startOffset);

    const trimRange = this.#calculateTrimRange(positionParams);

    // Direction the voice travels outside a loop: 1 forward, -1 reverse. The
    // playhead reads the same source position in either direction, so a
    // direction change needs no position correction.
    const approachDirection = this.reversePlayback !== trimRange.inverted ? -1 : 1;
    const driftAmount = parameters.loopDurationDriftAmount[0];
    let loopWindow;
    let previousPlaybackRate;

    const velocityGain = this.velocityGain;

    const basePan = parameters.pan[0];
    const numChannels = outputChannels.length; // Always process all output channels

    const isConstant = this.#getConstantFlags(parameters);

    // ===== Init playback position =====

    // Where reverse playback starts.
    const lastPosition = trimRange.endSamples - 1;

    // A turn can happen after the preceding block advanced past a trim edge.
    if (
      this.previousApproachDirection !== null &&
      this.previousApproachDirection !== approachDirection &&
      // A pitch loop a trim move just pushed can still sound outside trim.
      !(this.loopEnabled && this.loopWindow?.isPitchLoop && this.#isWithin(this.loopWindow))
    ) {
      if (this.playbackPosition >= trimRange.endSamples) {
        this.playbackPosition = lastPosition;
        this.timestretch.reset(this.playbackPosition);
      } else if (this.playbackPosition < trimRange.startSamples) {
        this.playbackPosition = trimRange.startSamples;
        this.timestretch.reset(this.playbackPosition);
      }
    }
    this.previousApproachDirection = approachDirection;

    this.trimMessage.trimStart = trimRange.startSamples / sampleRate;
    this.trimMessage.trimEnd = trimRange.endSamples / sampleRate;
    this.trimMessage.inverted = trimRange.inverted;
    this.#postRange(this.trimMessage, blockTime);

    // ===== AUDIO PROCESSING =====

    for (let sample = startOffset; sample < outputChannels[0].length; sample++) {
      const startGain =
        this.startFadeFrames < START_FADE_FRAMES ? this.startFadeFrames++ / START_FADE_FRAMES : 1;
      let stopGain = 1;
      if (this.pendingStopFrame !== null && blockFrame + sample >= this.pendingStopFrame) {
        stopGain = 1 - ++this.stopFadeFrames / STOP_FADE_FRAMES;
        if (stopGain <= 0) return this.#halt();
      }

      const frame = blockFrame + sample;
      while (this.pendingRates.length > 0 && frame >= this.pendingRates[0].frame) {
        const retune = this.pendingRates.shift();
        this.noteRateTarget = retune.rate;
        this.envelopes.noteRate = retune.rate;
        this.noteRateCoefficient = retune.coefficient;
      }
      this.noteRate += (this.noteRateTarget - this.noteRate) * this.noteRateCoefficient;
      const basePlaybackRate =
        this.noteRate *
        this.#getSafeParam(parameters.playbackRate, sample, isConstant.playbackRate);

      // Before the rate: a detune envelope bends it. A wrap at the end of the previous
      // sample restarts loop-synced envelopes here, on the loop's first sample.
      const envelopes = this.envelopes;
      envelopes.advance(
        blockFrame + sample,
        this.loopRate,
        this.loopEnabled,
        this.loopWrapped,
        this.loopWindow,
        this.buffer[0].length,
      );
      if (envelopes.gainDone && this.pendingStopFrame === null) {
        // The stop fade covers a tail that doesn't end at zero.
        this.pendingStopFrame = blockFrame + sample;
      }

      let detune = this.#getSafeParam(parameters.detune, sample, isConstant.detune);
      if (envelopes.detune.active) detune += envelopes.detune.value;
      if (filterOutput && envelopes.filter.active) filterOutput[sample] = envelopes.filter.value;
      const playbackRate =
        detune === 0 ? basePlaybackRate : basePlaybackRate * 2 ** (detune / 1200);

      positionParams.loopStartSamples =
        this.#getSafeParam(parameters.loopStart, sample) * sampleRate;
      positionParams.loopEndSamples = this.#getSafeParam(parameters.loopEnd, sample) * sampleRate;

      // Recalculate the range only when something moved. Short loops follow
      // their points per sample: their length is pitch. Long loops follow them
      // once per block, as k-rate did; per-sample zero-crossing snapping for
      // 16 voices overran the audio thread. The 2x margin keeps loops near the
      // audio-rate boundary (Float32 noise can lift them over it) per sample.
      const rangeInputsChanged =
        positionParams.loopStartSamples !== this.previousRequestedLoop.start ||
        positionParams.loopEndSamples !== this.previousRequestedLoop.end ||
        playbackRate !== previousPlaybackRate;
      const followsPointsPerSample = loopWindow?.length < 2 * this.pitchPreservationThreshold;
      const driftPending = driftAmount > 0 && this.loopEnabled && !this.loopDriftRolled;
      if (
        !loopWindow ||
        (rangeInputsChanged && followsPointsPerSample) ||
        this.isLoopLengthGliding ||
        this.isLoopPositionGliding ||
        driftPending
      ) {
        loopWindow = this.#calculateLoopWindow(
          positionParams,
          trimRange,
          driftAmount,
          playbackRate,
        );
        previousPlaybackRate = playbackRate;
      }

      // Both directions play the source samples [startSamples, endSamples).
      if (this.needsStartPosition) {
        this.needsStartPosition = false;
        const fromLoop = this.startFromLoop && this.loopEnabled;
        const first = fromLoop ? loopWindow.start : trimRange.startSamples;
        const last = fromLoop ? Math.min(loopWindow.end - 1, lastPosition) : lastPosition;
        this.playbackPosition = approachDirection < 0 ? last : first;
        this.timestretch.reset(this.playbackPosition);
      }

      this.loopWrapped = false;

      const envelopeGain = envelopes.gain.active ? envelopes.gain.value : 1;

      // Set per sample, not in #calculateLoopWindow: direction follows a-rate points
      // even when a time window's bounds resolve once per block. Turns wait for an edge.
      loopWindow.direction =
        positionParams.loopStartSamples > positionParams.loopEndSamples ? -1 : 1;
      // The rest of this sample plays the window the playhead follows.
      const playWindow = this.#carryPlayhead(
        loopWindow,
        this.loopTurned ? -approachDirection : approachDirection,
        trimRange,
      );

      this.smoothedPanDrift +=
        (this.currentPanDrift - this.smoothedPanDrift) * this.panDriftCoefficient;
      const envelopePan = envelopes.pan.active ? envelopes.pan.value : 0;
      const effectivePan = Math.max(-1, Math.min(1, basePan + this.smoothedPanDrift + envelopePan));

      // Loop rules apply once head and timeline are in the loop, not on the way to it.
      const approachingLoop =
        this.loopEnabled &&
        !this.loopTurned &&
        (isApproachingLoopWindow(this.playbackPosition, approachDirection, playWindow) ||
          isApproachingLoopWindow(
            this.timestretch.timelinePosition,
            approachDirection,
            playWindow,
          ));
      const inLoop = this.loopEnabled && !approachingLoop;

      const timestretchActive = this.timestretch.isActive(inLoop, playWindow.isPitchLoop);
      // Only a keytracked time loop runs past trimEnd, into silence.
      const tailEnd =
        !playWindow.isPitchLoop && playWindow.end > trimRange.endSamples
          ? trimRange.endSamples
          : Infinity;

      // Handle looping
      const maxLoopCount = parameters.maxLoopCount[0];
      const canWrapLoop = this.loopEnabled && this.loopCount < maxLoopCount;
      this.loopMessage.isInPitchLoop = canWrapLoop && inLoop && playWindow.isPitchLoop;
      if (canWrapLoop) {
        this.#passLoopEdge(approachDirection, playWindow, tailEnd, timestretchActive);
      }
      // Out of loop passes (the edge just passed may have been the last), or
      // loop off: play out in the approach direction
      if (!this.loopEnabled || this.loopCount >= maxLoopCount) this.loopTurned = false;
      const direction = this.loopTurned ? -approachDirection : approachDirection;
      const playbackStep = direction * Math.abs(playbackRate);
      // Next sample's envelope timing uses the transport rate that produced its loop state.
      this.loopRate = timestretchActive ? 1 : Math.abs(playbackStep);

      const timestretchJumpTarget = this.timestretch.prepareJump(
        timestretchActive,
        this.playbackPosition,
        playbackStep,
        canWrapLoop && inLoop ? playWindow.start : trimRange.startSamples,
        canWrapLoop && inLoop
          ? Math.min(trimRange.endSamples, playWindow.end)
          : trimRange.endSamples,
      );

      // End of playback: the playhead (or the stretcher's unit-rate timeline)
      // has left [startSamples, endSamples) in its direction of travel.
      // Don't stop in a keytracked loop's silent tail past trimEnd, or in a pitch loop
      // waiting to move inside a trim that moved.
      const transportPosition = timestretchActive
        ? this.timestretch.timelinePosition
        : this.playbackPosition;
      const overshoot =
        direction > 0
          ? transportPosition - trimRange.endSamples
          : trimRange.startSamples - transportPosition;
      const leftTrimRange = direction > 0 ? overshoot >= 0 : overshoot > 0;
      const holdsLoop = canWrapLoop && this.#isWithin(playWindow);

      if (leftTrimRange && !holdsLoop) {
        // More than one step past the end: trim moved past the playhead. Fade instead of cutting.
        if (overshoot <= Math.max(1, Math.abs(playbackStep))) return this.#halt();
        this.pendingStopFrame = Math.min(this.pendingStopFrame ?? Infinity, frame);
      }

      // 1 inside the audio, ramping to 0 at the audio end, 0 through the silent tail
      this.#collectReadHeads(tailGainAt(this.playbackPosition, tailEnd));
      // Generate output for each channel
      for (let channel = 0; channel < numChannels; channel++) {
        // Safety check: ensure output channel exists
        if (!outputChannels[channel]) continue;

        let mixed = this.#mixReadHeads(channel, Math.abs(playbackStep));
        if (this.loopMoveFadeLeft > 0) {
          const old = this.#mixReadHeads(channel, Math.abs(playbackStep), this.loopMoveOffset);
          mixed = old + (1 - this.loopMoveFadeLeft / this.loopMoveFadeFrames) * (mixed - old);
        }
        const finalSample = mixed * velocityGain * envelopeGain * masterGain * startGain * stopGain;

        // Apply pan (only affects stereo output)
        let panAdjustedSample = finalSample;
        if (outputChannels.length === 2) {
          if (channel === 0) {
            // Left channel: reduce gain when panned right (positive pan)
            panAdjustedSample = finalSample * (1 - Math.max(0, effectivePan));
          } else if (channel === 1) {
            // Right channel: reduce gain when panned left (negative pan)
            panAdjustedSample = finalSample * (1 - Math.max(0, -effectivePan));
          }
        }

        // Basic hard limiting
        outputChannels[channel][sample] = Math.max(
          -1,
          Math.min(1, isFinite(panAdjustedSample) ? panAdjustedSample : 0),
        );
      }
      this.loopCrossfade.advance(Math.abs(playbackStep));
      if (this.loopMoveFadeLeft > 0) this.loopMoveFadeLeft--;

      // Remember the rendered position, before a fractional step can overshoot
      // the edge. The next sample must carry that overshoot with a moving loop.
      this.previousPlaybackPosition = this.playbackPosition;
      this.playbackPosition = this.timestretch.advance(
        timestretchActive,
        this.playbackPosition,
        playbackStep,
        timestretchJumpTarget,
      );
    }

    // Effective range at the last audible sample, still throttled per voice.
    this.loopMessage.loopStart = loopWindow.start / sampleRate;
    this.loopMessage.loopEnd = loopWindow.end / sampleRate;
    this.loopMessage.loopMode = this.loopPingPong
      ? 'pingPong'
      : loopWindow.direction < 0
        ? 'backward'
        : 'forward';
    this.#postRange(this.loopMessage, blockTime);

    // Playhead for display, ~60 Hz to match screen refresh.
    if (this.reportPlaybackPosition) {
      // Not clamped to 1: a keytracked loop can play silent padding past the buffer end.
      this.positionMessage.position = Math.max(0, this.#samplesToNormalized(this.playbackPosition));
      this.#postRange(this.positionMessage, blockTime, 1 / 60);
    }
  }
}
