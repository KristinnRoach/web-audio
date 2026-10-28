import { SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS } from './sample-player-paramdescriptors.ts';
import { findNearestZeroCrossing } from '@/worklets/shared/utils/findNearestZeroCrossing.js';
import { DurationPreserver } from './duration-preservation.js';
import { reflectLoopPosition, wrapLoopPosition } from './loop-edges.js';

const DEFAULT_PITCH_PRESERVATION_THRESHOLD_SECONDS = 1 / 32.703;
// Closer to 1 extends smoothing. At 48 kHz, 0.9 decays by 99% in about 1 ms.
const LOOP_MOVE_CORRECTION_DECAY = 0.9;

// Linear interpolation of one channel's samples at a fractional position.
function interpolate(samples, position, lastIndex) {
  const index = Math.floor(position);
  const weight = position - index;
  const a = samples[Math.min(index, lastIndex)] || 0;
  const b = samples[Math.min(index + 1, lastIndex)] || 0;
  return a + weight * (b - a);
}

/**
 * Resolves two raw points into an ordered range inside [lo, hi], at least
 * `minLength` long (or as long as the bounds allow). Points arrive raw from the
 * main thread, so either may be set first and they may be equal.
 */
// Reused result: callers destructure it immediately, and this runs per sample.
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

export class SamplePlayerProcessor extends AudioWorkletProcessor {
  // ===== PARAMETER DESCRIPTORS =====
  static get parameterDescriptors() {
    return SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS;
  }

  // ===== CONSTRUCTOR =====

  constructor() {
    super();

    // Only set properties that should persist across resets.
    // audioData[0] is the authority: every buffer-derived range (duration, playback
    // range, click compensation) reads it via the `buffer`
    // getter below. Extra entries only contribute samples to the mix.
    this.audioData = [];
    this.audioDataGain = 1;
    this.loopEnabled = false;
    this.reversePlayback = false;
    this.panDriftEnabled = true;
    this.minZeroCrossing = 0;
    this.maxZeroCrossing = 0;

    this.usePlaybackPosition = false;
    this.enableLoopSmoothing = true; // Crossfade between loop points
    this.enableAdaptiveDrift = true; // Adaptive drift scaling based on loop duration
    this.syncLoopToTempo = false; // Todo: add controls for interactive testing
    // Ping-pong turns around at both loop edges and overrides loop point order.
    this.loopPingPong = false;
    // Keytrack loop: 0 = loop length fixed in samples (loop time shortens as you play higher).
    // 1 = loop length scales with playbackRate so real-time loop period stays constant across notes.
    // NOTE: Using keytrackLoopAmount > 0 means that audio-rate loop lengths no longer quantize to midinote
    this.keytrackLoopAmount = 0;

    this.durationPreserver = new DurationPreserver(sampleRate);

    // Glide time constant between quantized loop periods, not an arrival time
    // (~95% after 3x). 0 = stepped. Initial value matches samplerParams.loopRampDuration.
    this.loopRampDuration = 0.125;
    this.loopGlideCoefficient = -Math.expm1(-1 / sampleRate / this.loopRampDuration);
    this.loopGlideLogLength = null;

    this.port.onmessage = this.#handleMessage.bind(this);

    // Initialize all playback state
    this.#resetState();
    // Signal to node that processor is initialized
    this.port.postMessage({ type: 'initialized' });
  }

  /** Authority audio data. All range and duration math reads through this. */
  get buffer() {
    return this.audioData[0] ?? null;
  }

  // Shortest allowed playback range, can be inverted:
  // Math.abs(end - start) >= minRangeSamples
  // C5's period, lowered to the shortest quantize period so scales above C5 keep their pitch.
  get minRangeSamples() {
    return Math.min(sampleRate / 523.25, this.loopQuantizePeriods?.[0] ?? Infinity);
  }

  get pitchPreservationThreshold() {
    return (
      this.loopQuantizePeriods?.at(-1) ??
      Math.floor(sampleRate * DEFAULT_PITCH_PRESERVATION_THRESHOLD_SECONDS)
    );
  }

  // ===== MESSAGE HANDLING =====

  #handleMessage(event) {
    const {
      type,
      value,
      buffer,
      audioData,
      timestamp,
      durationSeconds,
      zeroCrossings,
      playbackDirection,
      triggerId,
    } = event.data;

    switch (type) {
      case 'setLoopQuantizePeriods':
        // Seconds to samples, ascending: [0] is the shortest, at(-1) the longest.
        this.loopQuantizePeriods = value
          .map((seconds) => seconds * sampleRate)
          .sort((a, b) => a - b);
        break;

      case 'voice:reset':
        this.#resetState();
        this.port.postMessage({ type: 'voice:reset' });
        break;

      case 'voice:setBuffer':
      case 'voice:setAudioData': {
        // Both messages replace all audio data, so state resets exactly
        // once and there is no partially-loaded window to get wrong.
        this.#resetState();
        this.zeroCrossings = [];
        this.minZeroCrossing = 0;
        this.maxZeroCrossing = 0;

        this.audioData = (audioData ?? (buffer ? [buffer] : [])).filter(Boolean);
        // ponytail: 1/N is correct for fully coherent entries (the same sample
        // stacked) and 3dB conservative otherwise. Add per-entry user gain
        // when a UI needs it.
        this.audioDataGain = this.audioData.length ? 1 / this.audioData.length : 1;

        this.port.postMessage({
          type: 'voice:loaded',
          durationSeconds,
          time: currentTime,
        });
        break;
      }

      case 'voice:setZeroCrossings':
        this.zeroCrossings = (zeroCrossings || []).map((timeSec) => timeSec * sampleRate);

        // Set min/max zero crossings for parameter constraints
        if (this.zeroCrossings.length > 0) {
          this.minZeroCrossing = this.zeroCrossings[0];
          this.maxZeroCrossing = this.zeroCrossings[this.zeroCrossings.length - 1];
        }
        break;

      case 'voice:start':
        this.isReleasing = false;
        this.isPlaying = true;
        this.triggerId = triggerId;
        this.loopCount = 0;
        this.nextDriftGenerated = false; // roll fresh drift for this note
        this.driftUpdateCounter = 0; // and don't let the short-loop cadence skip it
        this.loopTurned = false;
        this.loopGlideLogLength = null; // new notes start on the target length
        this.previousLoopRange = null;
        this.loopMoveCorrections = [];
        this.postedRanges = {}; // each note posts its first resolved range

        // Set from the trim range on the first audible block
        this.playbackPosition = 0;
        this.needsStartPosition = true;

        // Frame this note should sound at. A timestamp that has already passed
        // by the time the message arrives starts the note now.
        this.pendingStartFrame = timestamp ? Math.round(timestamp * sampleRate) : 0;
        break;

      case 'voice:release':
        this.isReleasing = true;
        break;

      case 'voice:stop':
        this.#stop();
        break;

      case 'setLoopEnabled':
        this.loopEnabled = value;

        this.port.postMessage({
          type: 'loop:enabled',
          enabled: value,
        });
        break;

      case 'setLoopPingPong':
        this.loopPingPong = value;
        break;

      case 'setPanDriftEnabled':
        this.panDriftEnabled = value;
        break;

      case 'voice:setPlaybackDirection': {
        // Global invert; inverted trim points flip it again in process()
        this.reversePlayback = playbackDirection === 'reverse';

        this.port.postMessage({
          type: 'voice:playbackDirectionChange',
          playbackDirection,
        });
        break;
      }

      case 'voice:usePlaybackPosition':
        this.usePlaybackPosition = value;
        break;

      case 'syncLoopToTempo':
        this.syncLoopToTempo = value;

        this.port.postMessage({
          type: 'loop:syncToTempo',
          enabled: value,
        });
        break;

      case 'setLoopRampDuration':
        this.loopRampDuration = value;
        this.loopGlideCoefficient = -Math.expm1(-1 / sampleRate / value);
        break;

      case 'setKeytrackLoopAmount':
        this.keytrackLoopAmount = Math.max(0, Math.min(1, value));
        break;

      case 'setPreserveDuration':
        this.durationPreserver.setEnabled(value, this.playbackPosition);
        break;
    }
  }

  // ===== METHODS =====

  #resetState() {
    this.isPlaying = false;
    this.isReleasing = false;
    this.pendingStartFrame = 0;
    this.triggerId = 0;
    this.velocitySensitivity = 1.0; // full velocity = unity gain

    this.previousApproachDirection = null;
    // True while cycling a loop against the approach direction (backward loops,
    // or the return half of a ping-pong). Direction = approach, negated when turned.
    this.loopTurned = false;
    this.playbackPosition = 0;
    this.needsStartPosition = false;

    this.debugCounter = 0;
    this.loopCount = 0;
    this.previousLoopRange = null;

    this.applyClickCompensation = false;
    this.loopClickCompensation = 0;
    this.loopMoveCorrections = [];

    // Loop & Pan drift feature
    this.driftUpdateCounter = 0;
    this.currentLoopDrift = 0;
    this.currentPanDrift = 0;
    this.PAN_DRIFT_DEPTH = 1.0; // Max pan offset at full loop drift; tune by ear

    this.nextDriftGenerated = false;

    this.durationPreserver.reset();
  }

  #stop() {
    this.isPlaying = false;
    this.isReleasing = false;
    this.pendingStartFrame = 0;
    this.playbackPosition = 0;
    this.needsStartPosition = false;
  }

  // Arm click compensation for a loop-wrap discontinuity between the sample
  // just emitted and the first sample of the next pass.
  #smoothLoopWrap(lastLoopSample, newFirstSample, loopDurationSamples, playbackRate) {
    const isHighRateAudioLoop =
      loopDurationSamples <= this.pitchPreservationThreshold && Math.abs(playbackRate) > 1;

    if (isHighRateAudioLoop) return;

    const discontinuity = lastLoopSample - newFirstSample;

    if (this.enableLoopSmoothing && Math.abs(discontinuity) > 0.01) {
      // Simple exponential smoothing
      this.loopClickCompensation = discontinuity * 0.5;
      this.compensationDecay = 0.9; // Smooth over ~32 samples
      this.applyClickCompensation = true;
    }
  }

  #smoothLoopMove(sample, channel, discontinuity) {
    // Correct only the relocation jump, allowing normal playback to advance.
    const correction = (this.loopMoveCorrections[channel] ?? 0) + discontinuity;
    this.loopMoveCorrections[channel] =
      Math.abs(correction) < 0.00001 ? 0 : correction * LOOP_MOVE_CORRECTION_DECAY;
    return sample + correction;
  }

  /**
   * Moves the playhead past the loop edge it has reached, if any: jumps to the
   * other edge, or turns around. Turning is what makes a loop backward (turn
   * once on arrival, then jump) or ping-pong (turn at every edge). A loop mode
   * change takes effect at the next edge, so direction never flips mid-loop.
   */
  #passLoopEdge(approachDirection, loopMode, loopRange, audioEndSamples, playbackRate) {
    const direction = this.loopTurned ? -approachDirection : approachDirection;
    const { loopStartSamples: loopStart, loopEndSamples: loopEnd } = loopRange;
    const turns = loopMode === 'pingPong' || this.loopTurned !== (loopMode === 'backward');
    const nextPosition = turns
      ? reflectLoopPosition(this.playbackPosition, direction, loopStart, loopEnd)
      : wrapLoopPosition(this.playbackPosition, direction, loopStart, loopEnd);
    if (nextPosition === null) return;

    if (turns) {
      // The playhead keeps reading neighbouring samples, so there is no step to smooth
      this.loopTurned = !this.loopTurned;
    } else {
      // Last emitted sample (one step back) against the first of the next pass.
      // Assumes a unit step, so it is approximate at other rates.
      this.#smoothLoopWrap(
        this.#sampleAt(this.playbackPosition - direction, audioEndSamples),
        this.#sampleAt(nextPosition, audioEndSamples),
        loopRange.loopDurationSamples,
        playbackRate,
      );
    }
    this.playbackPosition = nextPosition;
    this.loopCount++;

    // Reset drift flag to generate new drift for next loop iteration
    this.nextDriftGenerated = false;
  }

  // Authority sample at a source position, 0 at or past the audio end (the
  // keytracked silent tail).
  #sampleAt(position, audioEndSamples) {
    if (position >= audioEndSamples) return 0;
    return this.buffer[0][Math.floor(position)] || 0;
  }

  // Sum every loaded buffer at one position. Mono entries feed every output
  // channel; shorter entries contribute silence after their end.
  #sumAudioData(position, channel, lastAudioIndex) {
    let sum = 0;
    for (const data of this.audioData) {
      const samples = data[Math.min(channel, data.length - 1)];
      sum += interpolate(samples, position, lastAudioIndex) * this.audioDataGain;
    }
    return sum;
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
   * Calculate musical note durations in samples for given tempo
   * @param {number} tempo - BPM
   * @returns {Object} - Musical note durations in samples
   */
  #getTempoSyncedDurations(tempo) {
    const beatsPerSecond = tempo / 60;
    const samplesPerBeat = sampleRate / beatsPerSecond;

    return {
      // Standard notes
      whole: samplesPerBeat * 4,
      half: samplesPerBeat * 2,
      quarter: samplesPerBeat,
      eighth: samplesPerBeat / 2,
      sixteenth: samplesPerBeat / 4,
      thirtySecond: samplesPerBeat / 8,

      // Triplets (divide by 3/2 = multiply by 2/3)
      quarterTriplet: (samplesPerBeat * 2) / 3,
      eighthTriplet: ((samplesPerBeat / 2) * 2) / 3,
      sixteenthTriplet: ((samplesPerBeat / 4) * 2) / 3,
    };
  }

  /**
   * Sync loop duration to the nearest tempo-synced note duration (skips if below the shortest option)
   * @param {number} loopDurationSamples - Current loop duration in samples
   * @param {number} tempo - Current tempo in BPM
   * @param {number} playbackRate - Current playback rate
   * @returns {number} - Tempo-synced loop duration in samples
   */
  #syncLoopDurationToTempo(loopDurationSamples, tempo, playbackRate) {
    if (!this.syncLoopToTempo) {
      return loopDurationSamples;
    }

    const noteDurations = this.#getTempoSyncedDurations(tempo);

    // Account for playback rate - faster playback means shorter effective duration
    const effectiveDuration = loopDurationSamples / Math.abs(playbackRate);

    // Find the shortest option (32nd note)
    const smallestInterval = noteDurations.thirtySecond;

    // Skip syncing if the base duration is shorter than the shortest option
    if (effectiveDuration < smallestInterval) {
      return loopDurationSamples;
    }

    // Find closest musical interval
    const intervals = Object.values(noteDurations);
    let closestInterval = intervals[0];
    let smallestDiff = Math.abs(effectiveDuration - closestInterval);

    for (const interval of intervals) {
      const diff = Math.abs(effectiveDuration - interval);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        closestInterval = interval;
      }
    }

    // Convert back to samples accounting for playback rate
    return Math.floor(closestInterval * Math.abs(playbackRate));
  }

  /**
   * Extract and convert all position parameters from seconds to samples
   * @param {Object} parameters - AudioWorkletProcessor parameters
   * @returns {Object} - Converted parameters in samples
   */
  #extractPositionParams(parameters) {
    const samples = {
      startPointSamples: Math.floor(parameters.startPoint[0] * sampleRate),
      endPointSamples: Math.floor(parameters.endPoint[0] * sampleRate),
      // Keep loop points fractional: the loop length sets the pitch of an audio-rate
      // loop, and flooring rounded it to whole source samples (~5 cents at a
      // C5-length loop). Playback position and interpolation are already
      // fractional; every consumer that needs an index floors locally.
      loopStartSamples: parameters.loopStart[0] * sampleRate,
      loopEndSamples: parameters.loopEnd[0] * sampleRate,
    };
    return samples;
  }

  /**
   * Calculate effective playback range in samples
   * @param {Object} params - Position parameters from #extractPositionParams
   * @returns {Object} - Effective start and end positions
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
    const [startSamples, endSamples] = resolveRange(
      inward ? snapStart : lo,
      inward ? snapEnd : hi,
      0,
      bufferLength,
      this.minRangeSamples,
    );

    return {
      startSamples,
      endSamples,
      durationSamples: endSamples - startSamples,
      inverted: a > b, // start past end plays the range backward
    };
  }

  #canQuantizeLoopPeriod(period) {
    const periods = this.loopQuantizePeriods;
    return !!periods?.length && period >= 1 && period <= periods.at(-1);
  }

  // Select the nearest period target; glide is applied separately.
  #quantizeLoopPeriod(period) {
    if (!this.#canQuantizeLoopPeriod(period)) return period;
    const periods = this.loopQuantizePeriods;
    let best = periods[0];
    let distance = Math.abs(best - period);
    for (let i = 1; i < periods.length; i++) {
      const candidateDistance = Math.abs(periods[i] - period);
      if (candidateDistance < distance) {
        best = periods[i];
        distance = candidateDistance;
      }
    }
    return best;
  }

  // One-pole glide in the log domain (even pitch glide), once per audible sample.
  // Only inside the quantization range; outside it, or entering it, the length jumps.
  #glideLoopLength(target) {
    this.loopGliding = false;
    const periods = this.loopQuantizePeriods;
    if (!this.#canQuantizeLoopPeriod(target)) {
      this.loopGlideLogLength = null;
      return target;
    }
    const logTarget = Math.log(target);
    if (this.loopGlideLogLength === null || !(this.loopRampDuration > 0)) {
      this.loopGlideLogLength = logTarget;
    } else {
      this.loopGlideLogLength += (logTarget - this.loopGlideLogLength) * this.loopGlideCoefficient;
      this.loopGliding = Math.abs(logTarget - this.loopGlideLogLength) > 1e-12;
      if (!this.loopGliding) this.loopGlideLogLength = logTarget;
    }
    // The log round trip can exceed the longest period by an ULP and bypass quantization.
    return Math.min(Math.exp(this.loopGlideLogLength), periods.at(-1));
  }

  /**
   * Calculate effective loop range in samples with optional drift
   * @param {Object} params - Position parameters from #extractPositionParams
   * @param {Object} playbackRange - Range from #calculatePlaybackRange
   * @param {number} driftAmount - Loop duration drift amount (0-1)
   * @param {number} tempo - Current tempo in BPM
   * @param {number} playbackRate - Current playback rate
   * @returns {Object} - Effective loop start and end positions with drift applied.
   *   A reused object, valid until the call after next; copy it to keep it longer.
   */
  #calculateLoopRange(params, playbackRange, driftAmount = 0, tempo = 120, playbackRate = 1) {
    const { startSamples: rangeStart, endSamples: rangeEnd } = playbackRange;
    let lpStart = Math.min(params.loopStartSamples, params.loopEndSamples);
    let lpEnd = Math.max(params.loopStartSamples, params.loopEndSamples);

    // An audio-rate loop's length is its pitch. Shift it inside effective trim
    // to preserve its period when possible; longer loops clamp below.
    // A zero-length loop (end dragged onto start) floors at minRangeSamples,
    // which quantization lifts to the shortest period when a scale is set.
    let targetPeriod = this.#quantizeLoopPeriod(Math.max(this.minRangeSamples, lpEnd - lpStart));
    if (
      targetPeriod > playbackRange.durationSamples &&
      playbackRange.durationSamples <= this.pitchPreservationThreshold
    ) {
      targetPeriod =
        this.loopQuantizePeriods?.findLast((period) => period <= playbackRange.durationSamples) ??
        targetPeriod;
    }
    const loopPeriod = this.#glideLoopLength(targetPeriod);
    if (loopPeriod >= 1 && loopPeriod <= this.pitchPreservationThreshold) {
      // Preserve the period when it fits; otherwise fill trim without changing the target.
      const fittedLength = Math.min(loopPeriod, playbackRange.durationSamples);
      lpStart = Math.min(Math.max(lpStart, rangeStart), rangeEnd - fittedLength);
      lpEnd = lpStart + fittedLength;
    }

    // Same rule as the trim range, inside it. An unset loop (loopEnd's 99999
    // default) clamps to the full range.
    let [calcLoopStart, calcLoopEnd] = resolveRange(
      lpStart,
      lpEnd,
      rangeStart,
      rangeEnd,
      this.minRangeSamples,
    );

    let baseDuration = calcLoopEnd - calcLoopStart;

    // Apply tempo sync if enabled
    if (this.syncLoopToTempo) {
      const syncedDuration = this.#syncLoopDurationToTempo(baseDuration, tempo, playbackRate);

      calcLoopEnd = calcLoopStart + syncedDuration;
      // Ensure we don't exceed playback range
      calcLoopEnd = Math.min(calcLoopEnd, playbackRange.endSamples);
    }

    // Keytrack loop: scale sample-domain loop length by playbackRate so the real-time
    // loop time stays constant across notes (amount=1); amount=0 leaves it fixed.
    // Keytrack and tempo-sync both remap loop length as a function of playbackRate, in
    // opposite directions (real-time vs. musical length). They are mutually exclusive:
    // tempo-sync wins whenever it is enabled, even when syncing left the
    // duration unchanged (already on-grid, or too short to sync).
    if (
      baseDuration > this.pitchPreservationThreshold &&
      this.keytrackLoopAmount > 0 &&
      !this.syncLoopToTempo
    ) {
      const scale = 1 + this.keytrackLoopAmount * (Math.abs(playbackRate) - 1);
      baseDuration = Math.max(1, Math.floor(baseDuration * scale));
      // Deliberately unclamped: above the loop's root note the period is longer than
      // the available audio. The tail is padded with silence in process() so the
      // real-time period stays constant instead of collapsing to the buffer end.
      calcLoopEnd = calcLoopStart + baseDuration;
    }

    // Both branches above adjust calcLoopEnd (tempo-sync clamps, keytrack may
    // extend past the audio), so re-derive the actual duration before drift
    // uses it to size its minimum loop length.
    baseDuration = calcLoopEnd - calcLoopStart;

    const isAudioRate = baseDuration <= this.pitchPreservationThreshold;
    const minZeroCrossingLength = Math.max(this.pitchPreservationThreshold, this.minRangeSamples);

    // Only snap to zero crossing if it doesnt affect pitch (audio-rate loop duration).
    // Snaps move both ends inward, so each is kept only if the loop stays above the
    // audio-rate threshold and minimum: without an interior crossing, both could coincide.
    if (!isAudioRate) {
      const snappedStart = this.#findNearestZeroCrossing(calcLoopStart, 'right');
      if (calcLoopEnd - snappedStart > minZeroCrossingLength) {
        calcLoopStart = snappedStart;
      }
    }

    // Apply drift to loop end position
    if (driftAmount > 0 && this.loopEnabled) {
      // Generate new drift only at the start of each loop iteration
      if (!this.nextDriftGenerated) {
        // For short loops (audio-rate), update drift less frequently
        const updateInterval =
          baseDuration <= this.pitchPreservationThreshold
            ? Math.max(1, Math.floor(this.pitchPreservationThreshold / baseDuration))
            : 1;

        const shouldUpdateDrift = this.driftUpdateCounter % updateInterval === 0;

        if (shouldUpdateDrift) {
          this.currentLoopDrift = this.#generateLoopDrift(driftAmount, baseDuration);

          if (!isAudioRate && this.panDriftEnabled && driftAmount > 0 && this.loopCount > 0) {
            // Track the relative loop stretch, not its absolute sample count:
            // scaling raw samples made pan depend on loop length, so long loops
            // saturated to hard-panned while audio-rate loops got nothing.
            this.currentPanDrift = (this.currentLoopDrift / baseDuration) * this.PAN_DRIFT_DEPTH;
          } else {
            this.currentPanDrift = 0;
          }
        }

        this.driftUpdateCounter++;
        this.nextDriftGenerated = true;
      }

      // Apply drift to loop end, ensuring it stays within bounds
      const driftedLoopEnd = calcLoopEnd + this.currentLoopDrift;

      // Clamp to stay within playback range and ensure minimum loop duration
      const minLoopDuration = Math.max(1, Math.floor(baseDuration * 0.1)); // At least 10% of original duration
      // Ceiling is the keytracked end when it already reaches past the audio,
      // otherwise drift would pull the silence-padded tail back in.
      const maxLoopEnd = Math.max(playbackRange.endSamples, calcLoopEnd);
      calcLoopEnd = Math.max(calcLoopStart + minLoopDuration, Math.min(maxLoopEnd, driftedLoopEnd));
    } else {
      // Ensure pan drift is set to zero if no loopDrift applied
      this.currentPanDrift = 0;
    }

    // Snap the end last: drift moves the wrap point, so snapping before drift
    // leaves the actual loop end off a zero crossing -> discontinuity click.
    // Skip the snap when the end sits in the silent tail: zero crossings only exist
    // inside the buffer, so snapping there would erase the padding.
    if (!isAudioRate && calcLoopEnd <= playbackRange.endSamples) {
      const snappedEnd = this.#findNearestZeroCrossing(calcLoopEnd, 'left');
      if (snappedEnd - calcLoopStart > minZeroCrossingLength) {
        calcLoopEnd = snappedEnd;
      }
    }

    // Two reused slots instead of a new object per sample: process() compares
    // against previousLoopRange, so write into whichever slot that isn't.
    this.loopRangeSlots ??= [{}, {}];
    const range =
      this.loopRangeSlots[0] === this.previousLoopRange
        ? this.loopRangeSlots[1]
        : this.loopRangeSlots[0];
    range.loopStartSamples = calcLoopStart;
    range.loopEndSamples = calcLoopEnd;
    range.loopDurationSamples = calcLoopEnd - calcLoopStart;
    return range;
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
   * Generate a new drift amount for the current loop iteration
   * @param {number} driftAmount - Maximum drift amount (0-1)
   * @param {number} baseDuration - Base loop duration in samples
   * @returns {number} - Drift amount in samples
   */
  #generateLoopDrift(driftAmount, baseDuration) {
    if (driftAmount <= 0) return 0;

    // Generate random value between -1 and 1
    const randomFactor = (Math.random() - 0.5) * 2;

    // EXPERIMENTAL: Adaptive scaling based on loop duration
    let effectiveDriftAmount = driftAmount;

    if (this.enableAdaptiveDrift) {
      // Scale drift based on loop duration
      // Short loops (< 1024 samples ~= 23ms @ 44.1kHz) get much less drift
      // Long loops (> 8192 samples ~= 186ms @ 44.1kHz) get full drift
      const shortThreshold = 1024;
      const longThreshold = 8192;

      if (baseDuration < shortThreshold) {
        // Very short loops: reduce drift to 10% to preserve pitch
        effectiveDriftAmount *= 0.1;
      } else if (baseDuration < longThreshold) {
        // Medium loops: linear scaling from 10% to 100%
        const scaleFactor =
          0.1 + (0.9 * (baseDuration - shortThreshold)) / (longThreshold - shortThreshold);
        effectiveDriftAmount *= scaleFactor;
      }
      // Long loops: use full drift amount (no scaling)
    }

    // Scale by effective drift amount and base duration
    const maxDriftSamples = effectiveDriftAmount * baseDuration;

    // Round to the nearest source sample: floor turns even tiny negative drift
    // into a full-sample shortening of the loop.
    return Math.round(randomFactor * maxDriftSamples);
  }

  /**
   * Posts display state (`loop:range`, `trim:range`, `voice:position`), tagged
   * with the current `triggerId`. Compared against the last posted message of
   * that type for this note, so a change skipped by the throttle (`interval`
   * seconds, ~30 Hz by default) is sent on a later block.
   */
  #postRange(type, range, interval = 1 / 30) {
    this.postedRanges ??= {};
    const posted = this.postedRanges[type];
    if (posted && Object.keys(range).every((key) => range[key] === posted.range[key])) return;
    if (currentTime - (posted?.time ?? -1) < interval) return;
    this.postedRanges[type] = { range, time: currentTime };
    this.port.postMessage({ type, ...range, triggerId: this.triggerId });
  }

  /**
   * Resolves the loop range while idle, so the voice knows the snapped loop length
   * before the next note triggers its envelopes. Recomputed only when an input changed.
   * No drift and unit rate: drift is rolled per note, and the voice only uses this for
   * the steady loop length. ponytail: keytrack and tempo-sync lengths depend on the
   * note's rate, so those report the nominal length (no correction) until the voice
   * needs them.
   */
  #postIdleLoopRange(parameters) {
    const key = this.idleLoopKey ?? [];
    const inputs = [
      parameters.loopStart[0],
      parameters.loopEnd[0],
      parameters.startPoint[0],
      parameters.endPoint[0],
      this.buffer,
      this.zeroCrossings,
      this.loopQuantizePeriods,
      this.syncLoopToTempo,
      this.keytrackLoopAmount,
    ];
    if (inputs.every((value, i) => value === key[i])) return;
    this.idleLoopKey = inputs;

    const positionParams = this.#extractPositionParams(parameters);
    // A stopped note's glide must not leak in: the next note starts on the target length.
    this.loopGlideLogLength = null;
    const loopRange = this.#calculateLoopRange(
      positionParams,
      this.#calculatePlaybackRange(positionParams),
    );
    // The loop as set, before snapping: inside the raw trim range and the buffer.
    const {
      startPointSamples: a,
      endPointSamples: b,
      loopStartSamples: c,
      loopEndSamples: d,
    } = positionParams;
    const lo = Math.max(Math.min(a, b), 0);
    const hi = Math.min(Math.max(a, b), this.buffer[0].length);
    const clamp = (value) => Math.min(Math.max(value, lo), hi);
    const nominalLoopSeconds = Math.abs(clamp(d) - clamp(c)) / sampleRate;
    const loopStart = loopRange.loopStartSamples / sampleRate;
    // Resolved here at tempo 120 and rate 1, not the note's: report no correction.
    const rateDependent = this.syncLoopToTempo || this.keytrackLoopAmount > 0;
    // Unthrottled: the key check already limits this to real changes.
    this.#postRange(
      'loop:range',
      {
        loopStart,
        loopEnd: rateDependent
          ? loopStart + nominalLoopSeconds
          : loopRange.loopEndSamples / sampleRate,
        nominalLoopSeconds,
        idle: true,
      },
      0,
    );
  }

  // ===== MAIN PROCESS METHOD =====

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    this.debugCounter++;

    if (!output || !this.isPlaying || !this.buffer?.[0]?.length) {
      if (output && this.buffer?.[0]?.length) this.#postIdleLoopRange(parameters);
      return true;
    }

    // Handle different output structures
    let outputChannels;
    if (output instanceof Float32Array) {
      // Case 1: output is a single Float32Array (mono output - legacy)
      outputChannels = [output];
    } else if (Array.isArray(output) && output.every((ch) => ch instanceof Float32Array)) {
      // Case 2: output is array of Float32Arrays (stereo/multi-channel output)
      outputChannels = output;
    } else {
      console.error('Unexpected output structure:', {
        outputType: typeof output,
        isArray: Array.isArray(output),
        constructor: output?.constructor?.name,
        length: output?.length,
      });
      return true;
    }

    // ===== Scheduled start =====

    // Gate playback before any stateful preparation, such as loop-drift
    // generation, so silent lookahead blocks cannot change the first audible
    // block. Worklet output buffers start each render quantum cleared to zero.
    let startOffset = 0;
    if (this.pendingStartFrame > currentFrame) {
      startOffset = this.pendingStartFrame - currentFrame;
      // Whole quantum is before the note: stay silent, leave all state untouched.
      if (startOffset >= outputChannels[0].length) return true;
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
    const tempo = parameters.tempo[0];
    const driftAmount = parameters.loopDurationDriftAmount[0];
    let loopRange;
    let previousStart;
    let previousEnd;
    let previousRate;

    const velocityGain =
      this.#midiVelocityToGain(parameters.velocity[0]) * this.velocitySensitivity;

    // EXPERIMENTAL: Apply pan drift if enabled
    const basePan = parameters.pan[0];
    const numChannels = outputChannels.length; // Always process all output channels

    const isConstant = this.#getConstantFlags(parameters);

    const TAIL_FADE_SAMPLES = 64;

    // ===== Init playback position =====

    // Last position on the unit-rate grid, even when minimum-length growth is fractional.
    const lastPosition = playbackRange.startSamples + Math.ceil(playbackRange.durationSamples) - 1;

    // Both directions play the source samples [startSamples, endSamples).
    if (this.needsStartPosition) {
      this.needsStartPosition = false;
      this.playbackPosition = approachDirection < 0 ? lastPosition : playbackRange.startSamples;
      this.durationPreserver.reset(this.playbackPosition);
    }

    // A turn can happen after the preceding block advanced past a trim edge.
    if (
      this.previousApproachDirection !== null &&
      this.previousApproachDirection !== approachDirection
    ) {
      if (this.playbackPosition >= playbackRange.endSamples) {
        this.playbackPosition = lastPosition;
        this.durationPreserver.reset(this.playbackPosition);
      } else if (this.playbackPosition < playbackRange.startSamples) {
        this.playbackPosition = playbackRange.startSamples;
        this.durationPreserver.reset(this.playbackPosition);
      }
    }
    this.previousApproachDirection = approachDirection;

    this.#postRange('trim:range', {
      startPoint: playbackRange.startSamples / sampleRate,
      endPoint: playbackRange.endSamples / sampleRate,
      inverted: playbackRange.inverted,
    });

    // ===== AUDIO PROCESSING =====

    let loopMode = 'forward';
    for (let sample = startOffset; sample < outputChannels[0].length; sample++) {
      // Use getSafeParam for a-rate params
      const envelopeGain = this.#getSafeParam(parameters.envGain, sample, isConstant.envGain);
      const baseRate = this.#getSafeParam(parameters.playbackRate, sample, isConstant.playbackRate);
      const detune = this.#getSafeParam(parameters.detune, sample, isConstant.detune);
      const rate = detune === 0 ? baseRate : baseRate * 2 ** (detune / 1200);

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
      loopMode = this.loopPingPong ? 'pingPong' : loopStart > loopEnd ? 'backward' : 'forward';

      // Recalculate the range only when something moved. Short loops follow
      // their points per sample: their length is pitch. Long loops follow them
      // once per block, as k-rate did; per-sample zero-crossing snapping for
      // 16 voices overran the audio thread. The 2x margin keeps loops near the
      // audio-rate boundary (Float32 noise can lift them over it) per sample.
      const pointsChanged =
        loopStart !== previousStart || loopEnd !== previousEnd || rate !== previousRate;
      const followsPointsPerSample =
        loopRange?.loopDurationSamples < 2 * this.pitchPreservationThreshold;
      const driftPending = driftAmount > 0 && this.loopEnabled && !this.nextDriftGenerated;
      if (
        !loopRange ||
        (pointsChanged && followsPointsPerSample) ||
        this.loopGliding ||
        driftPending
      ) {
        loopRange = this.#calculateLoopRange(
          positionParams,
          playbackRange,
          driftAmount,
          tempo,
          rate,
        );
        previousStart = loopStart;
        previousEnd = loopEnd;
        previousRate = rate;
      }

      // An audio-rate loop's period is its pitch. The playhead is in buffer coordinates,
      // so a moving loop would shift its phase every sample and shorten or stretch the
      // cycles while it moves. Carry the playhead with the loop start instead.
      const previous = this.previousLoopRange;
      let moveOutgoingPosition = null;
      if (
        previous &&
        loopRange.loopStartSamples !== previous.loopStartSamples &&
        this.loopEnabled &&
        loopRange.loopDurationSamples <= this.pitchPreservationThreshold &&
        this.previousLoopPosition >= previous.loopStartSamples &&
        this.previousLoopPosition <= previous.loopEndSamples
      ) {
        if (this.enableLoopSmoothing) {
          // Continue the old loop independently: a simultaneous length change
          // can make the new range wrap/turn at a different source position.
          moveOutgoingPosition = this.playbackPosition;
          if (this.loopCount < parameters.maxLoopCount[0]) {
            const direction = this.loopTurned ? -approachDirection : approachDirection;
            const turns = loopMode === 'pingPong' || this.loopTurned !== (loopMode === 'backward');
            const mapEdge = turns ? reflectLoopPosition : wrapLoopPosition;
            moveOutgoingPosition =
              mapEdge(
                moveOutgoingPosition,
                direction,
                previous.loopStartSamples,
                previous.loopEndSamples,
              ) ?? moveOutgoingPosition;
          }
        }
        this.playbackPosition += loopRange.loopStartSamples - previous.loopStartSamples;
      }
      this.previousLoopRange = loopRange;

      const effectivePan = this.panDriftEnabled
        ? Math.max(-1, Math.min(1, basePan + this.currentPanDrift))
        : basePan;

      // The preserver still has no independent turn state for backward/ping-pong.
      const durationPreservationActive =
        (!this.loopEnabled || (loopMode === 'forward' && !this.loopTurned)) &&
        this.durationPreserver.isActive(
          this.zeroCrossings,
          this.loopEnabled,
          loopRange.loopDurationSamples,
          this.pitchPreservationThreshold,
        );
      const silencePadTail = loopRange.loopEndSamples > playbackRange.endSamples;

      // Handle looping
      const maxLoopCount = parameters.maxLoopCount[0];
      const canWrapLoop = this.loopEnabled && this.loopCount < maxLoopCount;
      if (canWrapLoop) {
        this.#passLoopEdge(approachDirection, loopMode, loopRange, playbackRange.endSamples, rate);
      }
      // Out of loop passes (the edge just passed may have been the last), or
      // loop off: play out in the approach direction
      if (!this.loopEnabled || this.loopCount >= maxLoopCount) this.loopTurned = false;
      const direction = this.loopTurned ? -approachDirection : approachDirection;
      const playbackStep = direction * Math.abs(rate);

      const durationCorrection = this.durationPreserver.prepareCorrection(
        durationPreservationActive,
        this.playbackPosition,
        playbackStep,
        this.zeroCrossings,
        this.buffer[0],
      );
      const durationResetTarget = durationCorrection?.resetTarget ?? null;
      if (durationCorrection) this.playbackPosition = durationCorrection.outgoingPosition;

      // End of playback: the playhead (or the preserver's unit-rate timeline)
      // has left [startSamples, endSamples) in its direction of travel.
      // Don't stop if we're looping and within the playback range.
      const transportPosition = durationPreservationActive
        ? this.durationPreserver.timelinePosition
        : this.playbackPosition;
      const leftPlaybackRange =
        direction > 0
          ? transportPosition >= playbackRange.endSamples
          : transportPosition < playbackRange.startSamples;
      const isWithinLoop =
        this.loopEnabled &&
        this.playbackPosition >= loopRange.loopStartSamples &&
        this.playbackPosition <= loopRange.loopEndSamples;

      if (leftPlaybackRange && !isWithinLoop) {
        const endedTriggerId = this.triggerId;
        this.#stop();
        this.port.postMessage({
          type: 'voice:ended',
          triggerId: endedTriggerId,
        });
        return true;
      }

      // 1 inside the audio, ramping to 0 at the audio end, 0 through the silent tail
      let tailGain = 1;
      if (silencePadTail) {
        const distToEnd = playbackRange.endSamples - this.playbackPosition;
        if (distToEnd < TAIL_FADE_SAMPLES) {
          tailGain = Math.max(0, distToEnd / TAIL_FADE_SAMPLES);
        }
      }

      // Sample interpolation, direction-independent: between the sample at and
      // after the playhead. Indices clamp to the last audio sample: endSamples can
      // be fractional (minimum-length growth), and a ping-pong turn at the audio
      // end reads exactly at endSamples. Past it, the silent tail gain is 0.
      const lastAudioIndex = Math.ceil(playbackRange.endSamples) - 1;
      // Generate output for each channel
      for (let channel = 0; channel < numChannels; channel++) {
        // Safety check: ensure output channel exists
        if (!outputChannels[channel]) {
          console.warn(
            `Output channel ${channel} does not exist. Available channels:`,
            outputChannels.length,
          );
          continue;
        }

        let interpolatedSample = this.#sumAudioData(this.playbackPosition, channel, lastAudioIndex);
        // Compare the old loop's continuation with the relocated playhead.
        let moveDiscontinuity = 0;
        if (moveOutgoingPosition !== null) {
          const outgoingSample = this.#sumAudioData(moveOutgoingPosition, channel, lastAudioIndex);
          moveDiscontinuity = outgoingSample - interpolatedSample;
        }

        // Original click compensation (still active)
        if (this.applyClickCompensation) {
          interpolatedSample += this.loopClickCompensation;

          // Apply decay for multi-sample smoothing
          if (this.compensationDecay) {
            this.loopClickCompensation *= this.compensationDecay;
            if (Math.abs(this.loopClickCompensation) < 0.001) {
              this.applyClickCompensation = false;
            }
          } else {
            this.applyClickCompensation = false; // Single sample mode
          }
        }

        interpolatedSample = this.#smoothLoopMove(interpolatedSample, channel, moveDiscontinuity);

        const finalSample =
          interpolatedSample * velocityGain * envelopeGain * masterGain * tailGain;

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

      // Remember the rendered position, before a fractional step can overshoot
      // the edge. The next sample must carry that overshoot with a moving loop.
      this.previousLoopPosition = this.playbackPosition;
      this.playbackPosition = this.durationPreserver.advance(
        durationPreservationActive,
        this.playbackPosition,
        playbackStep,
        durationResetTarget,
        canWrapLoop,
        loopRange.loopStartSamples,
        loopRange.loopEndSamples,
      );
    }

    // Effective range at the last audible sample, still throttled per voice.
    this.#postRange('loop:range', {
      loopStart: loopRange.loopStartSamples / sampleRate,
      loopEnd: loopRange.loopEndSamples / sampleRate,
      loopMode,
    });

    // Playhead for display, ~60 Hz to match screen refresh.
    if (this.usePlaybackPosition) {
      this.#postRange(
        'voice:position',
        { position: Math.max(0, Math.min(1, this.#samplesToNormalized(this.playbackPosition))) },
        1 / 60,
      );
    }

    return true;
  }
}

registerProcessor('sample-player-processor', SamplePlayerProcessor);
