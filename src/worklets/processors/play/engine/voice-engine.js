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
import { readSource, SincKernel } from './interpolation-kernels.js';
import {
  driftLoopEnd,
  driftRollInterval,
  glideCoefficient,
  glideToward,
  isInQuantizationRange,
  loopDriftSamples,
  longestPeriodWithin,
  quantizeLoopLength,
} from './loop-length.js';

const DEFAULT_PITCH_PRESERVATION_THRESHOLD_SECONDS = 1 / 32.703;
// Loop jump, turn and move crossfade length in source samples (~5 ms at 48 kHz).
const LOOP_CROSSFADE_SAMPLES = 256; // reasonable: 32 - 1024
// U-turn crossfade: a ping-pong or backward-loop turn has no step, but its slope
// reverses in one frame (a corner, audible at zero crossings). The crossfade
// rounds it off, at the cost of a brief level dip. Not standard sampler practice;
// false restores bare turns.
const LOOP_TURN_CROSSFADE = true;
const TAIL_FADE_SAMPLES = 64;
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
    this.random = random;
    this.post = post;

    // Only set properties that should persist across resets.
    this.buffer = null;

    this.loopEnabled = false;
    this.reversePlayback = false;
    this.panDriftEnabled = true;
    this.panDriftCoefficient = glideCoefficient(PAN_DRIFT_SMOOTHING_SECONDS, sampleRate);

    this.reportPlaybackPosition = false;
    /** @type {import('./interpolation-kernels.js').InterpolationMode} */
    this.interpolation = 'hermite';
    this.enableLoopCrossfade = true; // Crossfade between loop points
    this.loopCrossfade = new LoopCrossfade();
    this.loopWindowSlots = [new LoopWindow(), new LoopWindow()];
    // Ping-pong turns around at both loop edges and overrides loop point order.
    this.loopPingPong = false;
    // Keytrack loop. Resampling: 0 = loop length fixed in samples (loop time shortens as you
    // play higher), 1 = real-time loop duration constant across notes. Period stretch loops on
    // a unit-rate timeline and mirrors that: 0 = constant loop time, 1 = loop time / playbackRate.
    // NOTE: Using keytrackLoopAmount > 0 means that audio-rate loop lengths no longer quantize to midinote
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
      startPointSamples: 0,
      endPointSamples: 0,
      loopStartSamples: 0,
      loopEndSamples: 0,
    };
    this.playbackRange = { startSamples: 0, endSamples: 0, durationSamples: 0, inverted: false };
    this.previousRequestedLoop = { start: null, end: null };
    this.trimMessage = { type: 'trim:range', startPoint: 0, endPoint: 0, inverted: false };
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

  // Shortest allowed playback range, can be inverted:
  // Math.abs(end - start) >= minRangeSamples
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

  start(triggerId, timestamp) {
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
    this.pendingStartFrame = 0;
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
    this.pendingLoopCycleTime = null;
    this.loopWindow = null;
    this.loopCrossfade.reset();
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
    // Raw loop points in samples (start may pass end), from the last range calculation.
    this.previousRequestedLoop.start = null;
    this.previousRequestedLoop.end = null;
  }

  stop() {
    this.isPlaying = false;
    this.pendingStartFrame = 0;
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
  #passLoopEdge(approachDirection, loopWindow, silencePadTail, cycleTime, timestretchActive) {
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
      this.loopCrossfade.start(
        this.playbackPosition,
        direction,
        length,
        silencePadTail,
        loopWindow.audioEnd,
        loopWindow.audioStart,
      );
    }
    this.playbackPosition = nextPosition;
    if (timestretchActive) this.timestretch.reset(nextPosition);
    this.loopCount++;
    this.pendingLoopCycleTime = cycleTime;

    // Reset drift flag to generate new drift for next loop iteration
    this.loopDriftRolled = false;
  }

  // A pitch loop's length is its pitch. The playhead is in source coordinates, so
  // a moving window would shift its phase every sample and bend the cycles while
  // it moves. Carry the playhead with the window start instead.
  #carryPlayhead(window, approachDirection) {
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
      return;
    }
    if (this.enableLoopCrossfade && (!this.isLoopPositionGliding || this.isLoopStartClamped)) {
      // From the unmoved playhead, before any edge it passes this frame
      this.loopCrossfade.start(
        this.playbackPosition,
        this.loopTurned ? -approachDirection : approachDirection,
        this.#crossfadeLength(window),
        previous.end > previous.audioEnd,
        previous.audioEnd,
        previous.audioStart,
      );
    }
    this.playbackPosition += window.start - previous.start;
  }

  #addReadHead(position, gain, mix, firstIndex, lastIndex) {
    const head = this.readHeads[this.readHeadCount++];
    head.position = position;
    head.gain = gain;
    head.mix = mix;
    head.source.firstIndex = firstIndex;
    head.source.lastIndex = lastIndex;
  }

  // Innermost first. The stretcher's head stays inside the crossfade heads even when
  // it started later; among those, the newest is innermost, since each fades from
  // what was audible when it started. They keep their own tail gain, so the silent
  // tail can't mute the outgoing side of a reverse wrap.
  #collectReadHeads(tailGain, firstAudioIndex, lastAudioIndex) {
    this.readHeadCount = 0;
    this.#addReadHead(this.playbackPosition, tailGain, 0, firstAudioIndex, lastAudioIndex);
    if (this.timestretch.outgoingPosition !== null) {
      this.#addReadHead(
        this.timestretch.outgoingPosition,
        tailGain,
        this.timestretch.crossfadeMix,
        firstAudioIndex,
        lastAudioIndex,
      );
    }
    const crossfade = this.loopCrossfade;
    for (let i = crossfade.count - 1; i >= 0; i--) {
      const { position, fadesTail, audioStart, audioEnd, mix } = crossfade.head(i);
      this.#addReadHead(
        position,
        fadesTail ? tailGainAt(position, audioEnd) : 1,
        mix,
        Math.ceil(audioStart),
        Math.ceil(audioEnd) - 1,
      );
    }
  }

  // Each head's `mix` is the weight of the heads inside it. The innermost has
  // nothing inside it, so its 0 leaves it at full level. All heads move at `rate`.
  #mixReadHeads(channel, rate) {
    let mixed = 0;
    for (let i = 0; i < this.readHeadCount; i++) {
      const head = this.readHeads[i];
      // Mono sources feed every output channel. Each head keeps its own bounds,
      // including the saved trim end of an outgoing crossfade head.
      head.source.samples = this.buffer[Math.min(channel, this.buffer.length - 1)];
      const value =
        readSource(this.interpolation, head.source, head.position, rate, head.sincKernel) *
        head.gain;
      mixed = value + head.mix * (mixed - value);
    }
    return mixed;
  }

  #findNearestZeroCrossing(position, direction = 'any', maxDistance = null) {
    return findNearestZeroCrossing(this.zeroCrossings, position, direction, maxDistance);
  }

  // ===== CONVERSION UTILITIES =====

  /**
   * Convert sample index to normalized position (0-1)
   * @param {number} sampleIndex - Sample index
   * @returns {number} - Normalized position 0-1
   */
  #samplesToNormalized(sampleIndex) {
    if (!this.buffer || !this.buffer[0]) return 0;
    return sampleIndex / this.buffer[0].length;
  }

  /**
   * Convert MIDI velocity (0-127) to gain multiplier (0-1)
   * @param {number} midiVelocity - MIDI velocity 0-127
   * @returns {number} - Gain multiplier 0-1
   */
  #midiVelocityToGain(midiVelocity) {
    return Math.max(0, Math.min(1, midiVelocity / 127));
  }

  /**
   * Extract and convert all position parameters from seconds to samples
   * @param {Object} parameters - AudioWorkletProcessor parameters
   * @returns {Object} - Converted parameters in samples, a reused object
   */
  #extractPositionParams(parameters) {
    const samples = this.positionParams;
    samples.startPointSamples = Math.floor(parameters.startPoint[0] * this.sampleRate);
    samples.endPointSamples = Math.floor(parameters.endPoint[0] * this.sampleRate);
    // Keep loop points fractional: the loop length sets the pitch of an audio-rate
    // loop, and flooring rounded it to whole source samples (~5 cents at a
    // C5-length loop). Playback position and interpolation are already
    // fractional; every consumer that needs an index floors locally.
    samples.loopStartSamples = parameters.loopStart[0] * this.sampleRate;
    samples.loopEndSamples = parameters.loopEnd[0] * this.sampleRate;
    return samples;
  }

  /**
   * Calculate effective playback range in samples
   * @param {Object} params - Position parameters from #extractPositionParams
   * @returns {Object} - Effective start and end positions, a reused object
   */
  #calculatePlaybackRange(params) {
    const bufferLength = this.buffer?.[0]?.length || 0;
    const { startPointSamples: a, endPointSamples: b } = params;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);

    // Snap inward to zero crossings, then resolve like the loop points. Directional
    // snaps clamp to the outermost crossing, so keep them only if they stay inside.
    const snapStart = this.#findNearestZeroCrossing(lo, 'right');
    const snapEnd = this.#findNearestZeroCrossing(hi, 'left');
    const inward = lo <= snapStart && snapStart < snapEnd && snapEnd <= hi;
    const resolved = resolveRange(
      inward ? snapStart : lo,
      inward ? snapEnd : hi,
      0,
      bufferLength,
      this.minRangeSamples,
    );

    const range = this.playbackRange;
    range.startSamples = resolved[0];
    range.endSamples = resolved[1];
    range.durationSamples = resolved[1] - resolved[0];
    range.inverted = a > b; // start past end plays the range backward
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
   * @param {Object} playbackRange - Range from #calculatePlaybackRange
   * @param {number} driftAmount - Loop duration drift amount (0-1)
   * @param {number} playbackRate - Sounding playback rate, pitch modulation included
   * @returns {LoopWindow} - Resolved source window with drift applied.
   *   A reused object, valid until the call after next; copy it to keep it longer.
   */
  #calculateLoopWindow(params, playbackRange, driftAmount = 0, playbackRate = 1) {
    const { startSamples: rangeStart, endSamples: rangeEnd } = playbackRange;
    let lpStart = Math.min(params.loopStartSamples, params.loopEndSamples);
    let lpEnd = Math.max(params.loopStartSamples, params.loopEndSamples);

    // An audio-rate loop's length is its pitch. Shift it inside effective trim
    // to preserve its length when possible; longer loops clamp below.
    // A zero-length loop (end dragged onto start) floors at minRangeSamples,
    // which quantization lifts to the shortest period when a scale is set.
    let targetLoopLength = quantizeLoopLength(
      Math.max(this.minRangeSamples, lpEnd - lpStart),
      this.loopQuantizePeriods,
    );
    if (
      targetLoopLength > playbackRange.durationSamples &&
      playbackRange.durationSamples <= this.pitchPreservationThreshold
    ) {
      targetLoopLength =
        longestPeriodWithin(playbackRange.durationSamples, this.loopQuantizePeriods) ??
        targetLoopLength;
    }
    const glidedLoopLength = this.#glideLoopLength(targetLoopLength);
    // Decided on the requested length. A longer loop clipped short by trim is fitted as a
    // time loop here, then typed as a pitch loop by its resolved length below.
    if (glidedLoopLength >= 1 && glidedLoopLength <= this.pitchPreservationThreshold) {
      // Preserve the length when it fits; otherwise fill trim without changing the target.
      const fittedLength = Math.min(glidedLoopLength, playbackRange.durationSamples);
      const maxStart = rangeEnd - fittedLength;
      lpStart = Math.min(Math.max(lpStart, rangeStart), maxStart);
      // Trim or length can strand the glide outside the window; resolveRange would clip the loop.
      if (this.glidedLoopStart !== null) {
        const clampedStart = Math.min(Math.max(this.glidedLoopStart, rangeStart), maxStart);
        // Trim or a length glide can move the bound; over a sample counts as a jump to crossfade.
        this.isLoopStartClamped = Math.abs(clampedStart - this.glidedLoopStart) > 1;
        this.glidedLoopStart = clampedStart;
      }
      lpStart = this.#glideLoopPosition(lpStart, params, glidedLoopLength);
      lpEnd = lpStart + fittedLength;
    } else {
      // Above the audio-rate range this only tracks the start and clears the glide.
      this.#glideLoopPosition(lpStart, params, glidedLoopLength);
    }
    this.previousRequestedLoop.start = params.loopStartSamples;
    this.previousRequestedLoop.end = params.loopEndSamples;

    // Same rule as the trim range, inside it. An unset loop (loopEnd's 99999
    // default) clamps to the full range.
    const resolved = resolveRange(lpStart, lpEnd, rangeStart, rangeEnd, this.minRangeSamples);
    let calcLoopStart = resolved[0];
    let calcLoopEnd = resolved[1];

    let baseDuration = calcLoopEnd - calcLoopStart;

    // Loop type, from the resolved length. Later stages (keytrack, snap, drift) read it
    // and never change it, even when they move the length across the pitch cutoff.
    const isPitchLoop = baseDuration <= this.pitchPreservationThreshold;

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

    const minZeroCrossingLength = Math.max(this.pitchPreservationThreshold, this.minRangeSamples);

    // Only snap time loops: a pitch loop's length is its pitch.
    // Snaps move both ends inward, so each is kept only if the loop stays above the
    // pitch cutoff and minimum: without an interior crossing, both could coincide.
    if (!isPitchLoop) {
      const snappedStart = this.#findNearestZeroCrossing(calcLoopStart, 'right');
      if (calcLoopEnd - snappedStart > minZeroCrossingLength) {
        calcLoopStart = snappedStart;
      }
    }

    calcLoopEnd = this.#applyLoopDrift(
      calcLoopStart,
      calcLoopEnd,
      baseDuration,
      isPitchLoop,
      driftAmount,
      playbackRange.endSamples,
    );

    // Snap the end last: drift moves the wrap point, so snapping before drift
    // leaves the actual loop end off a zero crossing -> discontinuity click.
    // Skip the snap when the end sits in the silent tail: zero crossings only exist
    // inside the buffer, so snapping there would erase the padding.
    if (!isPitchLoop && calcLoopEnd <= playbackRange.endSamples) {
      const snappedEnd = this.#findNearestZeroCrossing(calcLoopEnd, 'left');
      if (snappedEnd - calcLoopStart > minZeroCrossingLength) {
        calcLoopEnd = snappedEnd;
      }
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
    window.audioStart = rangeStart;
    window.audioEnd = rangeEnd;
    return window;
  }

  #getSafeParam(paramArray, index, isConstant) {
    return isConstant ? paramArray[0] : paramArray[Math.min(index, paramArray.length - 1)];
  }

  #getConstantFlags(parameters) {
    this.constantFlags ??= {
      envGain: true,
      playbackRate: true,
      detune: true,
    };

    this.constantFlags.envGain = parameters.envGain.length === 1;
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
    inputs[2] = parameters.startPoint[0];
    inputs[3] = parameters.endPoint[0];
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
      this.#calculatePlaybackRange(positionParams),
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
  render(outputChannels, parameters, blockFrame, blockTime) {
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

    const positionParams = this.#extractPositionParams(parameters);

    const playbackRange = this.#calculatePlaybackRange(positionParams);

    // Direction the voice travels outside a loop: 1 forward, -1 reverse. The
    // playhead reads the same source position in either direction, so a
    // direction change needs no position correction.
    const approachDirection = this.reversePlayback !== playbackRange.inverted ? -1 : 1;
    const driftAmount = parameters.loopDurationDriftAmount[0];
    let loopWindow;
    let previousPlaybackRate;

    const velocityGain = this.#midiVelocityToGain(parameters.velocity[0]);

    const basePan = parameters.pan[0];
    const numChannels = outputChannels.length; // Always process all output channels

    const isConstant = this.#getConstantFlags(parameters);

    // ===== Init playback position =====

    // Last position on the unit-rate grid, even when minimum-length growth is fractional.
    const lastPosition = playbackRange.startSamples + Math.ceil(playbackRange.durationSamples) - 1;

    // Both directions play the source samples [startSamples, endSamples).
    if (this.needsStartPosition) {
      this.needsStartPosition = false;
      this.playbackPosition = approachDirection < 0 ? lastPosition : playbackRange.startSamples;
      this.timestretch.reset(this.playbackPosition);
    }

    // A turn can happen after the preceding block advanced past a trim edge.
    if (
      this.previousApproachDirection !== null &&
      this.previousApproachDirection !== approachDirection
    ) {
      if (this.playbackPosition >= playbackRange.endSamples) {
        this.playbackPosition = lastPosition;
        this.timestretch.reset(this.playbackPosition);
      } else if (this.playbackPosition < playbackRange.startSamples) {
        this.playbackPosition = playbackRange.startSamples;
        this.timestretch.reset(this.playbackPosition);
      }
    }
    this.previousApproachDirection = approachDirection;

    this.trimMessage.startPoint = playbackRange.startSamples / sampleRate;
    this.trimMessage.endPoint = playbackRange.endSamples / sampleRate;
    this.trimMessage.inverted = playbackRange.inverted;
    this.#postRange(this.trimMessage, blockTime);

    // ===== AUDIO PROCESSING =====

    for (let sample = startOffset; sample < outputChannels[0].length; sample++) {
      // Use getSafeParam for a-rate params
      const envelopeGain = this.#getSafeParam(parameters.envGain, sample, isConstant.envGain);
      const basePlaybackRate = this.#getSafeParam(
        parameters.playbackRate,
        sample,
        isConstant.playbackRate,
      );
      const detune = this.#getSafeParam(parameters.detune, sample, isConstant.detune);
      const playbackRate =
        detune === 0 ? basePlaybackRate : basePlaybackRate * 2 ** (detune / 1200);

      const loopStart = this.#getSafeParam(
        parameters.loopStart,
        sample,
        parameters.loopStart.length === 1,
      );
      const loopEnd = this.#getSafeParam(
        parameters.loopEnd,
        sample,
        parameters.loopEnd.length === 1,
      );
      positionParams.loopStartSamples = loopStart * sampleRate;
      positionParams.loopEndSamples = loopEnd * sampleRate;

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
          playbackRange,
          driftAmount,
          playbackRate,
        );
        previousPlaybackRate = playbackRate;
      }

      // Report the incoming range after its drift is resolved, keeping the wrap time.
      if (this.pendingLoopCycleTime !== null) {
        this.post({
          type: 'loop:cycle',
          loopSeconds: loopWindow.length / sampleRate,
          time: this.pendingLoopCycleTime,
          triggerId: this.triggerId,
        });
        this.pendingLoopCycleTime = null;
      }

      // Set per sample, not in #calculateLoopWindow: direction follows a-rate points
      // even when a time window's bounds resolve once per block. Turns wait for an edge.
      loopWindow.direction = loopStart > loopEnd ? -1 : 1;
      this.#carryPlayhead(loopWindow, approachDirection);

      this.smoothedPanDrift +=
        (this.currentPanDrift - this.smoothedPanDrift) * this.panDriftCoefficient;
      const effectivePan = Math.max(-1, Math.min(1, basePan + this.smoothedPanDrift));

      // Loop rules apply once head and timeline are in the loop, not on the way to it.
      const approachingLoop =
        this.loopEnabled &&
        !this.loopTurned &&
        (isApproachingLoopWindow(this.playbackPosition, approachDirection, loopWindow) ||
          isApproachingLoopWindow(
            this.timestretch.timelinePosition,
            approachDirection,
            loopWindow,
          ));
      const inLoop = this.loopEnabled && !approachingLoop;

      const timestretchActive = this.timestretch.isActive(inLoop, loopWindow.isPitchLoop);
      const silencePadTail = loopWindow.end > playbackRange.endSamples;

      // Handle looping
      const maxLoopCount = parameters.maxLoopCount[0];
      const canWrapLoop = this.loopEnabled && this.loopCount < maxLoopCount;
      this.loopMessage.isInPitchLoop = canWrapLoop && inLoop && loopWindow.isPitchLoop;
      if (canWrapLoop) {
        this.#passLoopEdge(
          approachDirection,
          loopWindow,
          silencePadTail,
          blockTime + sample / sampleRate,
          timestretchActive,
        );
      }
      // Out of loop passes (the edge just passed may have been the last), or
      // loop off: play out in the approach direction
      if (!this.loopEnabled || this.loopCount >= maxLoopCount) this.loopTurned = false;
      const direction = this.loopTurned ? -approachDirection : approachDirection;
      const playbackStep = direction * Math.abs(playbackRate);

      const timestretchJumpTarget = this.timestretch.prepareJump(
        timestretchActive,
        this.playbackPosition,
        playbackStep,
        canWrapLoop && inLoop
          ? Math.max(playbackRange.startSamples, loopWindow.start)
          : playbackRange.startSamples,
        canWrapLoop && inLoop
          ? Math.min(playbackRange.endSamples, loopWindow.end)
          : playbackRange.endSamples,
      );

      // End of playback: the playhead (or the stretcher's unit-rate timeline)
      // has left [startSamples, endSamples) in its direction of travel.
      // Don't stop if we're looping and within the playback range.
      const transportPosition = timestretchActive
        ? this.timestretch.timelinePosition
        : this.playbackPosition;
      const leftPlaybackRange =
        direction > 0
          ? transportPosition >= playbackRange.endSamples
          : transportPosition < playbackRange.startSamples;
      const isWithinLoop =
        this.loopEnabled &&
        this.playbackPosition >= loopWindow.start &&
        this.playbackPosition <= loopWindow.end;

      if (leftPlaybackRange && !isWithinLoop) {
        const endedTriggerId = this.triggerId;
        this.stop();
        this.post({
          type: 'voice:ended',
          triggerId: endedTriggerId,
        });
        return;
      }

      // 1 inside the audio, ramping to 0 at the audio end, 0 through the silent tail
      const tailGain = silencePadTail
        ? tailGainAt(this.playbackPosition, playbackRange.endSamples)
        : 1;

      // Sample interpolation, direction-independent. Taps clamp to the trim's
      // integer samples. endSamples can be fractional (minimum-length growth),
      // and a ping-pong turn reads exactly at endSamples. Past it, tail gain is 0.
      this.#collectReadHeads(
        tailGain,
        Math.ceil(playbackRange.startSamples),
        Math.ceil(playbackRange.endSamples) - 1,
      );
      // Generate output for each channel
      for (let channel = 0; channel < numChannels; channel++) {
        // Safety check: ensure output channel exists
        if (!outputChannels[channel]) continue;

        const finalSample =
          this.#mixReadHeads(channel, Math.abs(playbackStep)) *
          velocityGain *
          envelopeGain *
          masterGain;

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
      this.positionMessage.position = Math.max(
        0,
        Math.min(1, this.#samplesToNormalized(this.playbackPosition)),
      );
      this.#postRange(this.positionMessage, blockTime, 1 / 60);
    }
  }
}
