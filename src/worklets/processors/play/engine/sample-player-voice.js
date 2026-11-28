// One voice's playback state and rendering, free of AudioWorklet globals. The caller
// passes in the sample rate, block position and random source; messages go out through
// `postMessage`, synchronously, in the order they occur.

import { findNearestZeroCrossing } from '@/worklets/shared/utils/findNearestZeroCrossing.js';
import { PeriodLockStretcher } from './period-lock-stretch.js';
import { GrainPool, MAX_GRAINS, MAX_OUTGOING_GRAINS, MAX_SPAWNED_GRAINS } from './grain-pool.js';
import { EDGE_END, EDGE_LOOP, EDGE_NONE, isApproaching, PassScheduler } from './pass-scheduler.js';
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

const DEFAULT_PITCH_CUTOFF_SECONDS = 1 / 32.703;
// Loop jump and turn crossfade length in source samples (~5 ms at 48 kHz).
const LOOP_CROSSFADE_SAMPLES = 256; // reasonable: 32 - 1024
// Crossfade at the edge where a loop moves to a new start, in output seconds, so it
// sounds the same at every note. Longer than a plain wrap to smooth scanning between
// different waveforms. Short loops can exceed MAX_OUTGOING_GRAINS while moving, dropping
// the oldest grain early; more grains made no audible difference in listening tests.
const LOOP_MOVE_CROSSFADE_SECONDS = 0.02; // reasonable: 0.005 - 0.05
// U-turn crossfade: a ping-pong or reverse-loop turn has no step, but its slope
// reverses in one frame (a corner, audible at zero crossings). The crossfade
// rounds it off, at the cost of a brief level dip. Not standard sampler practice;
// false restores bare turns.
const LOOP_TURN_CROSSFADE = true;
// Source-domain fade into a loop's silence padding; not a note release.
const TAIL_FADE_SAMPLES = 64;
// Note-boundary de-click ramps, independent of pitch, direction and the musical
// amp envelope. Keep these in output frames; grain fades follow source position.
// Host stop: ~1.3 ms at 48 kHz.
const STOP_FADE_FRAMES = 64;
// Tiny opening ramp in output frames (~0.33 ms at 48 kHz).
const START_FADE_FRAMES = 16;
// Pan drift glide, so a new roll doesn't step the channel gains and click. Tune by ear.
const PAN_DRIFT_SMOOTHING_SECONDS = 0.02;
// Finite spawned grains (numGrains > 1): default window size, Hann taper and spread.
// Grain size and offset depth are set per voice; offset depth scales the max offset.
const SPAWNED_GRAIN_SECONDS = 0.1;
const SPAWNED_GRAIN_FADE_FRACTION = 0.25;
const SPAWNED_GRAIN_MAX_OFFSET_SECONDS = 0.5;
const SPAWNED_GRAIN_OFFSET_DEPTH = 0.1; // 50 ms
const SPAWNED_GRAIN_DETUNE_CENTS = 12;
const SPAWNED_GRAIN_PAN_SPREAD = 0.7;

function tailGainAt(position, audioEndSamples) {
  return Math.max(0, Math.min(1, (audioEndSamples - position) / TAIL_FADE_SAMPLES));
}

function panGain(channel, numChannels, pan) {
  if (numChannels !== 2) return 1;
  return channel === 0 ? 1 - Math.max(0, pan) : 1 - Math.max(0, -pan);
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

export class SamplePlayerVoice {
  #loopDriftPassCount = 0;
  #driftPending = true;
  #random;
  #postMessage;
  #panDriftEnabled;
  #panDriftCoefficient;
  #noteRateTarget;
  #noteRateCoefficient;
  #velocityGain;
  #pendingRates;
  #resolvedLoopWindow;
  #passes;
  #keytrackLoopAmount;
  #loopKeytrackOptions;
  #loopLengthGlideCoefficient;
  #loopPositionGlideCoefficient;
  #positionParams;
  #trimRange;
  #previousRequestedLoop;
  #trimMessage;
  #loopMessage;
  #positionMessage;
  #readHeadCount;
  #idleLoopInputs;
  #idleLoopKey;
  #idleLoopPostTime;
  #loopQuantizePeriods;
  #zeroCrossings;
  #postedRanges;
  #needsStartPosition;
  #inLoop;
  #loopRate;
  #currentLoopDrift;
  #currentPanDrift;
  #smoothedPanDrift;
  #isLoopLengthGliding;
  #glidedLoopLogLength;
  #isLoopPositionGliding;
  #glidedLoopStart;
  #stopFadeFrames;
  #constantFlags;
  #numGrains;
  #grainSeconds;
  #grainOffsetDepth;
  #spawnCountdown;

  /**
   * @param {Object} options
   * @param {number} options.sampleRate - Context sample rate
   * @param {() => number} options.random - Random values in [0, 1)
   * @param {(message: Object) => void} options.postMessage - Receives outgoing messages
   */
  constructor({ sampleRate, random, postMessage }) {
    this.sampleRate = sampleRate;
    this.#random = random;
    this.#postMessage = postMessage;

    // Only set properties that should persist across resets.
    this.buffer = null;

    this.loopEnabled = false;
    this.playbackDirection = 'forward';
    // Note-on starts at the loop instead of trim while looping is on.
    this.startFromLoop = false;
    this.#panDriftEnabled = true;
    this.#panDriftCoefficient = glideCoefficient(PAN_DRIFT_SMOOTHING_SECONDS, sampleRate);

    this.reportPlayheadPosition = false;

    // Per-note values from voice:start. The playbackRate param multiplies noteRate.
    this.noteRate = 1;
    this.#noteRateTarget = 1;
    this.#noteRateCoefficient = 1;
    this.#velocityGain = 1;
    // Retunes waiting for their frames (voice:setRate), in timestamp order.
    this.#pendingRates = [];

    // Gain is unity unless its slot is active; detune adds to the param (see voice-envelopes.js).
    this.envelopes = new VoiceEnvelopes(sampleRate);
    /** @type {import('./interpolation-kernels.js').InterpolationMode} */
    this.interpolation = 'hermite';
    this.enableEdgeFades = true; // Fade a grain out at every edge
    // The playhead, outgoing crossfade grains, and finite spawned grains.
    this.grains = new GrainPool();
    this.#numGrains = 1;
    this.#grainSeconds = SPAWNED_GRAIN_SECONDS;
    this.#grainOffsetDepth = SPAWNED_GRAIN_OFFSET_DEPTH;
    this.#spawnCountdown = 0;
    // The loop window as the params ask for it now, reused per resolve.
    this.#resolvedLoopWindow = new LoopWindow();
    // The note's passes. A loop pass plays the latched loop window: loop changes are
    // heard at the next wrap or turn, or sooner when they pull its end in.
    this.#passes = new PassScheduler();
    // Ping-pong turns around at both loop edges and overrides loop edge order.
    this.loopPingPong = false;
    // Keytrack loop. Resampling: 0 = loop length fixed in samples (loop time shortens as you
    // play higher), 1 = real-time loop duration constant across notes. Period stretch loops on
    // the original-speed position and mirrors that: 0 = constant loop time, 1 = loop time / playbackRate.
    this.#keytrackLoopAmount = 0;
    // Reused during rendering to avoid allocating options per sample.
    this.#loopKeytrackOptions = { rootNote: 60, depth: 0, mapping: 'exponential' };

    this.timestretch = new PeriodLockStretcher(sampleRate);

    // Glide time constant between quantized loop periods, not an arrival time
    // (~95% after 3x). 0 = stepped. Initial value matches samplerParams.loopLengthGlide.
    this.#loopLengthGlideCoefficient = glideCoefficient(0.125, sampleRate);
    this.#loopPositionGlideCoefficient = glideCoefficient(0, sampleRate);

    // Reused per block and per sample, so rendering doesn't allocate.
    this.#positionParams = {
      trimStartSamples: 0,
      trimEndSamples: 0,
      loopStartSamples: 0,
      loopEndSamples: 0,
    };
    this.#trimRange = { startSamples: 0, endSamples: 0, inverted: false };
    this.#previousRequestedLoop = { start: null, end: null };
    this.#trimMessage = { type: 'trim:range', trimStart: 0, trimEnd: 0, inverted: false };
    this.#loopMessage = { type: 'loop:range', loopStart: 0, loopEnd: 0, loopMode: 'forward' };
    this.#positionMessage = { type: 'voice:position', position: 0 };
    // Everything sounding this sample: the playhead, the stretcher's fade-out head,
    // outgoing grains, and finite spawned grains.
    this.readHeads = Array.from({ length: MAX_OUTGOING_GRAINS + MAX_SPAWNED_GRAINS + 2 }, () => ({
      position: 0,
      gain: 1,
      rateRatio: 1,
      pan: 0,
      source: new ClampedSourceReader(),
      sincKernel: new SincKernel(),
    }));
    this.#readHeadCount = 0;
    this.#idleLoopInputs = [];
    this.#idleLoopKey = [];

    // Initialize all playback state
    this.reset();
  }

  /** The current grain's position in source samples. */
  get playheadPosition() {
    return this.grains.current.position;
  }

  set playheadPosition(position) {
    this.grains.current.position = position;
  }

  // C5's wavelength, lowered to the shortest loop quantize period so periods above C5 keep their pitch.
  get minRangeSamples() {
    return Math.min(this.sampleRate / 523.25, this.#loopQuantizePeriods?.[0] ?? Infinity);
  }

  // Pitch cutoff in source samples: the longest loop that counts as a pitch loop.
  get pitchCutoff() {
    return (
      this.#loopQuantizePeriods?.at(-1) ??
      Math.floor(this.sampleRate * DEFAULT_PITCH_CUTOFF_SECONDS)
    );
  }

  // Rendering needs a note and a source; otherwise the voice is idle.
  get canRender() {
    return this.isPlaying && !!this.buffer?.[0]?.length;
  }

  // ===== CONTROLS =====

  setLoopQuantizePeriods(seconds) {
    // Seconds to samples, ascending: [0] is the shortest, at(-1) the longest.
    this.#loopQuantizePeriods = seconds
      .map((value) => value * this.sampleRate)
      .sort((a, b) => a - b);
  }

  setBuffer(buffer) {
    this.reset();
    for (const head of this.readHeads) head.source.samples = null;
    this.#zeroCrossings = [];
    this.timestretch.setPeriods(null, 1);
    this.buffer = buffer ?? null;
  }

  setZeroCrossings(zeroCrossings) {
    this.#zeroCrossings = (zeroCrossings || []).map((timeSec) => timeSec * this.sampleRate);
  }

  setPitchPeriods(periods, hopSamples) {
    this.timestretch.setPeriods(periods, hopSamples);
  }

  /**
   * `note.noteRate` is the note's rate, gliding there from `glideFrom` over
   * `glideSeconds` (a time constant, as setTargetAtTime). `velocity` is 0-127.
   */
  start(triggerId, timestamp, note = {}) {
    const { noteRate = 1, velocity = 127, glideFrom, glideSeconds = 0 } = note;
    this.#noteRateTarget = noteRate;
    this.noteRate = glideSeconds > 0 && glideFrom !== undefined ? glideFrom : noteRate;
    this.#noteRateCoefficient = glideCoefficient(glideSeconds, this.sampleRate);
    this.#pendingRates.length = 0;
    this.#velocityGain = Math.max(0, Math.min(1, velocity / 127));

    this.isPlaying = true;
    this.triggerId = triggerId;
    this.#resetNoteLoop();
    this.#postedRanges = {}; // each note posts its first resolved range

    // Set from the trim range on the first audible block
    this.playheadPosition = 0;
    this.#needsStartPosition = true;

    // Frame this note should sound at. A timestamp that has already passed
    // by the time the message arrives starts the note now.
    this.pendingStartFrame = timestamp ? Math.round(timestamp * this.sampleRate) : 0;
    this.startFadeFrames = 0;
    this.#clearStop(); // a new note supersedes the previous note's stop
    // Envelopes start on the note's first audible sample.
    this.envelopes.trigger(noteRate);
  }

  /** Retunes the sounding note at `timestamp`, gliding with a `glideSeconds` time constant. */
  setNoteRate(timestamp, noteRate, glideSeconds = 0) {
    this.#pendingRates.push({
      frame: timestamp ? Math.round(timestamp * this.sampleRate) : 0,
      rate: noteRate,
      coefficient: glideCoefficient(glideSeconds, this.sampleRate),
    });
    this.#pendingRates.sort((a, b) => a.frame - b.frame);
  }

  /** Routes an envelope config to its target, or clears it with null. */
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

  get panDriftEnabled() {
    return this.#panDriftEnabled;
  }

  setPanDriftEnabled(enabled) {
    this.#panDriftEnabled = enabled;
    if (!enabled) this.#currentPanDrift = 0;
  }

  setLoopLengthGlide(seconds) {
    this.#loopLengthGlideCoefficient = glideCoefficient(seconds, this.sampleRate);
  }

  setLoopPositionGlide(seconds) {
    this.#loopPositionGlideCoefficient = glideCoefficient(seconds, this.sampleRate);
  }

  setKeytrackLoopAmount(amount) {
    this.#keytrackLoopAmount = Math.max(0, Math.min(1, amount));
  }

  setTimestretchMode(mode) {
    this.timestretch.setEnabled(mode === 'period', this.playheadPosition);
  }

  get numGrains() {
    return this.#numGrains;
  }

  /** Number of simultaneous grains per voice (1 = playhead only; >1 spawns finite grains). */
  setNumGrains(count) {
    const next = Math.max(1, Math.min(MAX_GRAINS, Math.round(count)));
    this.#numGrains = Number.isFinite(next) ? next : 1;
  }

  /** Spawned grain length in seconds. */
  setGrainSize(seconds) {
    this.#grainSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : SPAWNED_GRAIN_SECONDS;
  }

  /** Spawned grain start offset depth in [0, 1], scaling the max offset from the playhead. */
  setGrainOffset(depth) {
    this.#grainOffsetDepth = Number.isFinite(depth)
      ? Math.max(0, Math.min(1, depth))
      : SPAWNED_GRAIN_OFFSET_DEPTH;
  }

  // ===== METHODS =====

  reset() {
    this.isPlaying = false;
    this.#pendingRates.length = 0;
    this.pendingStartFrame = 0;
    this.startFadeFrames = 0;
    this.#clearStop();
    this.triggerId = 0;

    this.playheadPosition = 0;
    this.#needsStartPosition = false;
    this.#resetNoteLoop();
    this.timestretch.reset();
  }

  // Loop state each note starts from.
  #resetNoteLoop() {
    this.#passes.reset();
    this.loopWrapped = false;
    this.#inLoop = false; // as of the previous sample
    this.isInPitchLoop = false;
    this.loopWindow = null;
    this.#loopRate = 1;
    this.grains.reset();
    this.#spawnCountdown = 0;
    this.#resetLoopGlides(); // new notes start on the target range

    this.#loopDriftPassCount = 0;
    this.#driftPending = true;
    this.#currentLoopDrift = 0;
    this.#currentPanDrift = 0;
    this.#smoothedPanDrift = 0;
  }

  #resetLoopGlides() {
    this.#isLoopLengthGliding = false;
    this.#glidedLoopLogLength = null;
    this.#isLoopPositionGliding = false;
    this.#glidedLoopStart = null;
    // Raw loop edges in samples (start may pass end), from the last range calculation.
    this.#previousRequestedLoop.start = null;
    this.#previousRequestedLoop.end = null;
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
    this.#stopFadeFrames = 0;
  }

  // Every note that ends, by stop or at the playback boundary, reports it once.
  #halt() {
    this.#postMessage({ type: 'voice:ended', triggerId: this.triggerId });
    this.isPlaying = false;
    this.#pendingRates.length = 0;
    this.pendingStartFrame = 0;
    this.#clearStop();
    this.playheadPosition = 0;
    this.#needsStartPosition = false;
  }

  // Capped to a fraction of the pass, so short loops get short fades. A loop moving
  // to a new start gets its own, longer fade.
  #crossfadeLength(passLength, moves, speed) {
    // Source samples per output second: matches the rate that advances outgoing grains.
    if (moves) return LOOP_MOVE_CROSSFADE_SECONDS * this.sampleRate * speed;
    return Math.min(LOOP_CROSSFADE_SAMPLES, passLength / 4);
  }

  /**
   * Ends the current pass once the playhead reaches its edge, through the pass
   * scheduler. Every edge that moves or stops the playhead fades a grain out from
   * where it was: a wrap, a turn, or the note's last edge.
   */
  #passEdge(approachDirection, resolved, trimRange, timestretchActive, speed) {
    const passes = this.#passes;
    const direction = passes.direction(approachDirection);
    const tailEnd = passes.pass.tailEnd;
    const edge = passes.passEdge(
      timestretchActive ? this.timestretch.originalSpeedPosition : this.grains.current.position,
      approachDirection,
      timestretchActive ? 1 : speed,
      this.loopEnabled,
      this.loopPingPong,
      resolved,
      trimRange,
    );
    if (edge === EDGE_NONE) return;

    if (this.enableEdgeFades && (!passes.turnedAtEdge || LOOP_TURN_CROSSFADE)) {
      // The outgoing grain carries on past the edge in the pre-turn direction.
      const length = this.#crossfadeLength(passes.endedLength, passes.moved, speed);
      this.grains.fadeOut(direction, length, tailEnd);
    }
    if (edge === EDGE_END) return this.grains.endCurrent();

    this.grains.current.position = passes.landing;
    if (timestretchActive) this.timestretch.reset(passes.landing);
    if (edge !== EDGE_LOOP) return;
    this.loopWrapped = true;
    // Wraps and turns both advance the drift cadence.
    this.#loopDriftPassCount++;
    this.#driftPending = true;
  }

  // Spotykach-style grain spawner: keeps up to (numGrains - 1) finite windowed grains
  // active alongside the playhead, staggered in time with random offset, detune and pan.
  #maybeSpawnGrain(direction, regionStart, regionEnd, tailEnd) {
    const targetExtras = this.#numGrains - 1;
    if (targetExtras <= 0) return;
    if (this.#spawnCountdown > 0) this.#spawnCountdown--;
    if (this.grains.spawnedCount >= targetExtras || this.#spawnCountdown > 0) return;

    const length = Math.max(1, Math.round(this.#grainSeconds * this.sampleRate));
    const fadeLength = length * SPAWNED_GRAIN_FADE_FRACTION;
    const regionLength = Math.max(0, regionEnd - regionStart);
    const maxOffset = Math.min(
      this.#grainOffsetDepth * SPAWNED_GRAIN_MAX_OFFSET_SECONDS * this.sampleRate,
      regionLength * 0.5,
    );
    const offset = (this.#random() * 2 - 1) * maxOffset;
    const maxPos = Math.max(regionStart, regionEnd - 1);
    const position = Math.min(Math.max(this.grains.current.position + offset, regionStart), maxPos);
    const detuneCents = (this.#random() * 2 - 1) * SPAWNED_GRAIN_DETUNE_CENTS;
    const rateRatio = detuneCents === 0 ? 1 : 2 ** (detuneCents / 1200);
    const pan = (this.#random() * 2 - 1) * SPAWNED_GRAIN_PAN_SPREAD;

    this.grains.spawn(position, direction, rateRatio, pan, length, fadeLength, tailEnd);
    // Stagger the next spawn so overlapping grains don't pulse in unison.
    const interval = (length / targetExtras) * (0.5 + this.#random() * 0.5);
    this.#spawnCountdown = Math.max(1, Math.round(interval));
  }

  #addReadHead(position, gain, rateRatio = 1, pan = 0) {
    const head = this.readHeads[this.#readHeadCount++];
    head.position = position;
    head.gain = gain;
    head.rateRatio = rateRatio;
    head.pan = pan;
  }

  // Collects every active read head with its additive weight. The playhead, stretcher
  // fade head and outgoing grains resolve their nested crossfade into plain weights
  // (outermost to innermost, summing to 1); spawned grains add on top with their own
  // envelope gain, rate ratio and pan.
  #collectReadHeads(tailGain) {
    this.#readHeadCount = 0;
    const grains = this.grains;
    let remaining = 1;
    for (let i = 0; i < grains.count; i++) {
      const { position, tailEnd, mix } = grains.outgoing(i);
      this.#addReadHead(position, tailGainAt(position, tailEnd) * remaining * (1 - mix));
      remaining *= mix;
    }
    if (this.timestretch.fadeOutPosition !== null) {
      const mix = this.timestretch.crossfadeMix;
      this.#addReadHead(this.timestretch.fadeOutPosition, tailGain * remaining * (1 - mix));
      remaining *= mix;
    }
    // Once the playhead stops, outgoing grains fade out to silence.
    if (grains.current.active) {
      this.#addReadHead(grains.current.position, tailGain * remaining);
    }
    for (let i = 0; i < grains.spawnedCount; i++) {
      const { position, tailEnd, gain, rateRatio, pan } = grains.spawned(i);
      if (gain <= 0) continue;
      this.#addReadHead(position, tailGainAt(position, tailEnd) * gain, rateRatio, pan);
    }
  }

  // Sums every read head with its own playback rate and pan offset.
  #mixReadHeads(channel, numChannels, rate, effectivePan) {
    let sum = 0;
    for (let i = 0; i < this.#readHeadCount; i++) {
      const { source, sincKernel, position, gain, rateRatio, pan } = this.readHeads[i];
      // Mono sources feed every output channel.
      source.samples = this.buffer[Math.min(channel, this.buffer.length - 1)];
      const value = readSource(this.interpolation, source, position, rate * rateRatio, sincKernel);
      const headPan = pan === 0 ? effectivePan : Math.max(-1, Math.min(1, effectivePan + pan));
      sum += value * gain * panGain(channel, numChannels, headPan);
    }
    return sum;
  }

  #findNearestZeroCrossing(position, direction = 'any', maxDistance = null) {
    return findNearestZeroCrossing(this.#zeroCrossings, position, direction, maxDistance);
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
    const samples = this.#positionParams;
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
    return snapped >= start && end - snapped > this.pitchCutoff ? snapped : start;
  }

  #snapEnd(start, end) {
    const snapped = this.#findNearestZeroCrossing(end, 'left');
    return snapped <= end && snapped - start > this.pitchCutoff ? snapped : end;
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

    const range = this.#trimRange;
    range.startSamples = start;
    range.endSamples = end;
    range.inverted = params.trimStartSamples > params.trimEndSamples;
    return range;
  }

  // One-pole glide in the log domain (even pitch glide), once per audible sample.
  // Only inside the quantization range; outside it, or entering it, the length jumps.
  #glideLoopLength(target) {
    this.#isLoopLengthGliding = false;
    if (!isInQuantizationRange(target, this.#loopQuantizePeriods)) {
      this.#glidedLoopLogLength = null;
      return target;
    }
    const logTarget = Math.log(target);
    if (this.#glidedLoopLogLength === null) {
      this.#glidedLoopLogLength = logTarget;
    } else {
      this.#glidedLoopLogLength = glideToward(
        this.#glidedLoopLogLength,
        logTarget,
        this.#loopLengthGlideCoefficient,
        1e-12,
      );
      this.#isLoopLengthGliding = this.#glidedLoopLogLength !== logTarget;
    }
    // The log round trip can exceed the longest period by an ULP and bypass quantization.
    return Math.min(Math.exp(this.#glidedLoopLogLength), this.#loopQuantizePeriods.at(-1));
  }

  // Move the source window gradually; each pass latches where the glide has got to.
  #glideLoopPosition(targetStart, params, length) {
    const requestedSpan = params.loopEndSamples - params.loopStartSamples;
    const previous = this.#previousRequestedLoop;
    // Paired Float32 AudioParams lose precision when translated far into the buffer.
    const tolerance =
      Math.max(
        Math.abs(targetStart),
        Math.abs(this.#glidedLoopStart ?? 0),
        Math.abs(requestedSpan),
        1,
      ) *
      2 ** -22;
    const lengthUnchanged = Math.abs(requestedSpan - (previous.end - previous.start)) <= tolerance;
    this.#isLoopPositionGliding = false;
    if (
      !this.loopEnabled ||
      !lengthUnchanged ||
      !isInQuantizationRange(length, this.#loopQuantizePeriods) ||
      this.#glidedLoopStart === null ||
      this.#loopPositionGlideCoefficient === 1
    ) {
      this.#glidedLoopStart = targetStart;
      return targetStart;
    }
    this.#glidedLoopStart = glideToward(
      this.#glidedLoopStart,
      targetStart,
      this.#loopPositionGlideCoefficient,
      1e-6,
    );
    this.#isLoopPositionGliding = this.#glidedLoopStart !== targetStart;
    return this.#glidedLoopStart;
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
    const isPitchLoop = calcLoopEnd - calcLoopStart <= this.pitchCutoff;

    if (isPitchLoop) {
      // Constrained to trim while keeping its quantized/glided length as long as it fits.
      // A zero-length loop (end dragged onto start) floors at minRangeSamples,
      // which quantization lifts to the shortest loop quantize period, if any.
      const targetLength = quantizeLoopLength(
        Math.max(this.minRangeSamples, calcLoopEnd - calcLoopStart),
        this.#loopQuantizePeriods,
      );
      const glidedLength = this.#glideLoopLength(targetLength);
      const fittedLength = Math.min(glidedLength, trimLength);
      const maxStart = trimEnd - fittedLength;
      if (this.#glidedLoopStart !== null) {
        // Trim pushes the glide along with it.
        this.#glidedLoopStart = Math.min(Math.max(this.#glidedLoopStart, trimStart), maxStart);
      }
      calcLoopStart = this.#glideLoopPosition(
        Math.min(Math.max(calcLoopStart, trimStart), maxStart),
        params,
        glidedLength,
      );
      calcLoopEnd = Math.min(calcLoopStart + fittedLength, trimEnd);
    } else {
      calcLoopStart = Math.min(Math.max(calcLoopStart, trimStart), trimEnd);
      calcLoopEnd = Math.min(Math.max(calcLoopEnd, trimStart), trimEnd);
      // Too little of it inside trim to be a time loop: loop the whole trim.
      if (calcLoopEnd - calcLoopStart <= this.pitchCutoff) {
        calcLoopStart = trimStart;
        calcLoopEnd = trimEnd;
      }
      // No glides; a loop that becomes a pitch loop glides its position from here.
      this.#isLoopLengthGliding = false;
      this.#glidedLoopLogLength = null;
      this.#isLoopPositionGliding = false;
      this.#glidedLoopStart = calcLoopStart;
    }
    this.#previousRequestedLoop.start = params.loopStartSamples;
    this.#previousRequestedLoop.end = params.loopEndSamples;

    let baseDuration = calcLoopEnd - calcLoopStart;

    const keytrackAmount = isPitchLoop ? 0 : this.#keytrackLoopAmount;
    if (keytrackAmount > 0) {
      // Only time loops get here, so stretch applies whenever it is on.
      const keytrackOptions = this.#loopKeytrackOptions;
      keytrackOptions.depth = this.timestretch.canStretch ? -keytrackAmount : keytrackAmount;
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

    // Reused instead of a new object per sample; the latched window is a copy.
    const window = this.#resolvedLoopWindow;
    window.start = calcLoopStart;
    window.length = calcLoopEnd - calcLoopStart;
    window.isPitchLoop = isPitchLoop;
    // A window resolved past trimEnd plays silence past it.
    window.tailEnd = calcLoopEnd > trimEnd ? trimEnd : Infinity;
    return window;
  }

  #getSafeParam(paramArray, index, isConstant = paramArray.length === 1) {
    return isConstant ? paramArray[0] : paramArray[Math.min(index, paramArray.length - 1)];
  }

  #getConstantFlags(parameters) {
    this.#constantFlags ??= {
      playbackRate: true,
      detune: true,
    };

    this.#constantFlags.playbackRate = parameters.playbackRate.length === 1;
    this.#constantFlags.detune = parameters.detune.length === 1;

    return this.#constantFlags;
  }

  /**
   * Moves the loop end by the current iteration's drift, rolling it if needed.
   * @param {number} baseDuration - Loop duration in samples, before zero-crossing snaps
   * @returns {number} - Drifted loop end in samples
   */
  #applyLoopDrift(loopStart, loopEnd, baseDuration, isPitchLoop, driftAmount, playbackEnd) {
    if (driftAmount <= 0 || !this.loopEnabled) {
      this.#currentPanDrift = 0;
      return loopEnd;
    }

    if (this.#driftPending) this.#updateLoopDrift(driftAmount, baseDuration, isPitchLoop);

    return driftLoopEnd(loopStart, loopEnd, baseDuration, this.#currentLoopDrift, playbackEnd);
  }

  /** Checks once per loop pass whether drift is due for a new roll. */
  #updateLoopDrift(driftAmount, baseDuration, isPitchLoop) {
    const updateInterval = driftRollInterval(baseDuration, this.pitchCutoff);

    if (this.#loopDriftPassCount % updateInterval === 0) {
      this.#currentLoopDrift = loopDriftSamples(this.#random(), driftAmount, baseDuration);
      // Pitch loop drift is scaled down and rounded to whole samples, often to nothing,
      // so pan rolls its own value there.
      const panDrift = isPitchLoop
        ? (this.#random() - 0.5) * 2 * driftAmount
        : this.#currentLoopDrift / baseDuration;
      this.#currentPanDrift = this.#panDriftEnabled && this.#loopDriftPassCount > 0 ? panDrift : 0;
    }

    this.#driftPending = false;
  }

  /**
   * Posts display state (`loop:range`, `trim:range`, `voice:position`), tagged
   * with the current `triggerId`. Compared against the last posted message of
   * that type for this note, so a change skipped by the throttle (`interval`
   * seconds, ~30 Hz by default) is sent on a later block. Only a message actually
   * posted allocates; `fields` is reused by the caller.
   */
  #postRange(fields, blockTime, interval = 1 / 30) {
    this.#postedRanges ??= {};
    const posted = this.#postedRanges[fields.type];
    if (posted && hasSameValues(fields, posted.message)) return;
    if (blockTime - (posted?.time ?? -1) < interval) return;
    const message = { ...fields, triggerId: this.triggerId };
    this.#postedRanges[fields.type] = { message, time: blockTime };
    this.#postMessage(message);
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
    if (blockTime - (this.#idleLoopPostTime ?? -1) < interval) return;
    const key = this.#idleLoopKey;
    const inputs = this.#idleLoopInputs;
    inputs[0] = parameters.loopStart[0];
    inputs[1] = parameters.loopEnd[0];
    inputs[2] = parameters.trimStart[0];
    inputs[3] = parameters.trimEnd[0];
    inputs[4] = this.buffer;
    inputs[5] = this.#zeroCrossings;
    inputs[6] = this.#loopQuantizePeriods;
    inputs[7] = this.#keytrackLoopAmount;
    let changed = false;
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i] !== key[i]) changed = true;
    }
    if (!changed) return;
    // The inputs become the key; the old key is the next call's scratch.
    this.#idleLoopKey = inputs;
    this.#idleLoopInputs = key;
    this.#idleLoopPostTime = blockTime;

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
    this.#postMessage({
      type: 'loop:range',
      loopStart: loopWindow.start / this.sampleRate,
      loopEnd: loopWindow.end / this.sampleRate,
      // Resolved at playback rate 1: the voice rescales the length by the note's playback rate.
      keytrackAmount: loopWindow.isPitchLoop ? 0 : this.#keytrackLoopAmount,
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
    const approachDirection =
      (this.playbackDirection === 'reverse') !== trimRange.inverted ? -1 : 1;
    const driftAmount = parameters.loopDurationDriftAmount[0];
    let loopWindow;
    let previousPlaybackRate;

    const velocityGain = this.#velocityGain;

    const basePan = parameters.pan[0];
    const numChannels = outputChannels.length; // Always process all output channels

    const isConstant = this.#getConstantFlags(parameters);

    // Where reverse playback starts.
    const lastPosition = trimRange.endSamples - 1;
    const passes = this.#passes;
    const current = this.grains.current;

    this.#trimMessage.trimStart = trimRange.startSamples / sampleRate;
    this.#trimMessage.trimEnd = trimRange.endSamples / sampleRate;
    this.#trimMessage.inverted = trimRange.inverted;
    this.#postRange(this.#trimMessage, blockTime);

    // ===== AUDIO PROCESSING =====

    for (let sample = startOffset; sample < outputChannels[0].length; sample++) {
      const startGain =
        this.startFadeFrames < START_FADE_FRAMES ? this.startFadeFrames++ / START_FADE_FRAMES : 1;
      let stopGain = 1;
      if (this.pendingStopFrame !== null && blockFrame + sample >= this.pendingStopFrame) {
        stopGain = 1 - ++this.#stopFadeFrames / STOP_FADE_FRAMES;
        if (stopGain <= 0) return this.#halt();
      }

      const frame = blockFrame + sample;
      while (this.#pendingRates.length > 0 && frame >= this.#pendingRates[0].frame) {
        const retune = this.#pendingRates.shift();
        this.#noteRateTarget = retune.rate;
        this.envelopes.noteRate = retune.rate;
        this.#noteRateCoefficient = retune.coefficient;
      }
      this.noteRate += (this.#noteRateTarget - this.noteRate) * this.#noteRateCoefficient;
      const basePlaybackRate =
        this.noteRate *
        this.#getSafeParam(parameters.playbackRate, sample, isConstant.playbackRate);

      // Before the rate: a detune envelope bends it. A wrap at the end of the previous
      // sample restarts loop-synced envelopes here, on the loop's first sample.
      const envelopes = this.envelopes;
      envelopes.advance(
        blockFrame + sample,
        this.#loopRate,
        this.loopEnabled,
        this.loopWrapped,
        this.loopWindow,
        this.buffer[0].length,
        this.#inLoop,
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
      const loopEndOffset = envelopes.loopEnd.active ? envelopes.loopEnd.value : 0;
      const baseLoopEndSamples = Math.min(
        this.#getSafeParam(parameters.loopEnd, sample) * sampleRate,
        this.buffer[0].length,
      );
      positionParams.loopEndSamples = baseLoopEndSamples + loopEndOffset * sampleRate;

      // Recalculate the range only when something moved. Short loops follow
      // their points per sample: their length is pitch. Long loops follow them
      // once per block, as k-rate did; per-sample zero-crossing snapping for
      // 16 voices overran the audio thread. The 2x margin keeps loops near the
      // audio-rate boundary (Float32 noise can lift them over it) per sample.
      const rangeInputsChanged =
        positionParams.loopStartSamples !== this.#previousRequestedLoop.start ||
        positionParams.loopEndSamples !== this.#previousRequestedLoop.end ||
        playbackRate !== previousPlaybackRate;
      const followsPointsPerSample = loopWindow?.length < 2 * this.pitchCutoff;
      const driftPending = driftAmount > 0 && this.loopEnabled && this.#driftPending;
      if (
        !loopWindow ||
        (rangeInputsChanged && followsPointsPerSample) ||
        this.#isLoopLengthGliding ||
        this.#isLoopPositionGliding ||
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
      if (this.#needsStartPosition) {
        this.#needsStartPosition = false;
        const fromLoop = this.startFromLoop && this.loopEnabled;
        const first = fromLoop ? loopWindow.start : trimRange.startSamples;
        const last = fromLoop ? Math.min(loopWindow.end - 1, lastPosition) : lastPosition;
        current.position = approachDirection < 0 ? last : first;
        this.timestretch.reset(current.position);
        passes.startNote(trimRange.startSamples, trimRange.endSamples);
      }

      this.loopWrapped = false;

      const envelopeGain = envelopes.gain.active ? envelopes.gain.value : 1;

      // Set per sample, not in #calculateLoopWindow: direction follows a-rate points
      // even when a time window's bounds resolve once per block. Turns wait for an edge.
      loopWindow.direction =
        positionParams.loopStartSamples > positionParams.loopEndSamples ? -1 : 1;

      const canStretch = this.timestretch.canStretch;
      const playing = current.active;
      // The loop starts once the playhead, and the original-speed position if stretch
      // is available, have reached the resolved window. From then on each pass plays
      // the latched window.
      if (
        playing &&
        this.loopEnabled &&
        !(
          canStretch &&
          isApproaching(this.timestretch.originalSpeedPosition, approachDirection, loopWindow)
        )
      ) {
        passes.enterLoop(current.position, approachDirection, loopWindow);
      }
      const inLoop = this.loopEnabled && passes.isLoopPass;
      this.#inLoop = inLoop;
      // The rest of this sample plays the latched window, or the resolved one on the way in.
      const playWindow = inLoop ? passes.pass : loopWindow;
      this.loopWindow = playWindow;

      this.#smoothedPanDrift +=
        (this.#currentPanDrift - this.#smoothedPanDrift) * this.#panDriftCoefficient;
      const envelopePan = envelopes.pan.active ? envelopes.pan.value : 0;
      const effectivePan = Math.max(
        -1,
        Math.min(1, basePan + this.#smoothedPanDrift + envelopePan),
      );

      const timestretchActive = !(inLoop && playWindow.isPitchLoop) && canStretch;

      if (playing) {
        passes.pullEndIn(
          passes.direction(approachDirection),
          this.loopEnabled,
          trimRange,
          loopWindow,
        );
        this.#passEdge(
          approachDirection,
          loopWindow,
          trimRange,
          timestretchActive,
          Math.abs(playbackRate),
        );
        if (this.grains.isSilent) return this.#halt();
      } else if (this.grains.isSilent) {
        return this.#halt();
      }
      // After #passEdge so voice/range reports match a window latched at this edge.
      this.isInPitchLoop = inLoop && playWindow.isPitchLoop;
      const direction = passes.direction(approachDirection);
      const playbackStep = direction * Math.abs(playbackRate);
      // Next sample's envelope timing uses the transport rate that produced its loop state.
      this.#loopRate = timestretchActive ? 1 : Math.abs(playbackStep);

      const timestretchJumpTarget = this.timestretch.prepareJump(
        timestretchActive,
        current.position,
        playbackStep,
        inLoop ? playWindow.start : trimRange.startSamples,
        inLoop ? Math.min(trimRange.endSamples, playWindow.end) : trimRange.endSamples,
      );

      if (current.active && this.#numGrains > 1) {
        const regionStart = inLoop ? playWindow.start : trimRange.startSamples;
        const regionEnd = inLoop
          ? Math.min(trimRange.endSamples, playWindow.end)
          : trimRange.endSamples;
        this.#maybeSpawnGrain(direction, regionStart, regionEnd, trimRange.endSamples);
      }

      // 1 inside the audio, ramping to 0 at the audio end, 0 through the silent tail
      this.#collectReadHeads(tailGainAt(current.position, passes.pass.tailEnd));
      const grainNorm = this.#numGrains > 1 ? 1 / Math.sqrt(this.#numGrains) : 1;
      // Generate output for each channel
      for (let channel = 0; channel < numChannels; channel++) {
        // Safety check: ensure output channel exists
        if (!outputChannels[channel]) continue;

        const mixed = this.#mixReadHeads(
          channel,
          numChannels,
          Math.abs(playbackStep),
          effectivePan,
        );
        const finalSample =
          mixed * grainNorm * velocityGain * envelopeGain * masterGain * startGain * stopGain;

        // Basic hard limiting
        outputChannels[channel][sample] = Math.max(
          -1,
          Math.min(1, isFinite(finalSample) ? finalSample : 0),
        );
      }
      this.grains.advance(Math.abs(playbackStep));

      current.position = this.timestretch.advance(
        timestretchActive,
        current.position,
        playbackStep,
        timestretchJumpTarget,
      );
    }

    // The window playing at the last audible sample (latched once in the loop), still
    // throttled per voice. Loop mode is reported as requested.
    const playedWindow = this.loopWindow;
    this.#loopMessage.loopStart = playedWindow.start / sampleRate;
    this.#loopMessage.loopEnd = playedWindow.end / sampleRate;
    this.#loopMessage.isInPitchLoop = this.isInPitchLoop;
    this.#loopMessage.loopMode = this.loopPingPong
      ? 'pingPong'
      : loopWindow.direction < 0
        ? 'reverse'
        : 'forward';
    this.#postRange(this.#loopMessage, blockTime);

    // Playhead for display, ~60 Hz to match screen refresh.
    if (this.reportPlayheadPosition) {
      // Not clamped to 1: a keytracked loop can play silent padding past the buffer end.
      this.#positionMessage.position = Math.max(
        0,
        this.#samplesToNormalized(this.playheadPosition),
      );
      this.#postRange(this.#positionMessage, blockTime, 1 / 60);
    }
  }
}
