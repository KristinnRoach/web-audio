import { SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS } from "./sample-player-paramdescriptors.ts";
import { findNearestZeroCrossing } from "@/worklets/shared/utils/findNearestZeroCrossing.js";
import { DurationPreserver } from "./duration-preservation.js";

export class SamplePlayerProcessor extends AudioWorkletProcessor {
  // ===== PARAMETER DESCRIPTORS =====
  static get parameterDescriptors() {
    return SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS;
  }

  // ===== CONSTRUCTOR =====

  constructor() {
    super();

    // Only set properties that should persist across resets.
    // Layer 0 is the authority: every buffer-derived range (duration, playback
    // range, loop amplitude, click compensation) reads it via the `buffer`
    // getter below. Extra layers only contribute samples to the mix.
    this.layers = [];
    this.layerGain = 1;
    this.minZeroCrossing = 0;
    this.maxZeroCrossing = 0;

    this.usePlaybackPosition = false;
    this.enableLoopSmoothing = true; // Crossfade between loop points
    this.enableAdaptiveDrift = true; // Adaptive drift scaling based on loop duration
    this.enableAmplitudeCompensation = true; // Automatic makeup gain for short loops
    this.syncLoopToTempo = false; // Todo: add controls for interactive testing
    // Keytrack loop: 0 = loop length fixed in samples (loop time shortens as you play higher).
    // 1 = loop length scales with playbackRate so real-time loop period stays constant across notes.
    // NOTE: Using keytrackLoopAmount > 0 means that audio-rate loop lengths no longer quantize to midinote
    this.keytrackLoopAmount = 0;

    this.durationPreserver = new DurationPreserver(sampleRate);

    // C0 (lowest piano note) = ~16.35 Hz
    // Period = 1/16.35 ≈ 0.061 seconds
    this.PITCH_PRESERVATION_THRESHOLD = Math.floor(sampleRate * 0.061);

    this.AMPLITUDE_COMPENSATION_THRESHOLD = Math.floor(sampleRate / 16.35);

    this.port.onmessage = this.#handleMessage.bind(this);

    // Initialize all playback state
    this.#resetState();
    // Signal to node that processor is initialized
    this.port.postMessage({ type: "initialized" });
  }

  /** Authority layer. All range and duration math reads through this. */
  get buffer() {
    return this.layers[0] ?? null;
  }

  // ===== MESSAGE HANDLING =====

  #handleMessage(event) {
    const {
      type,
      value,
      buffer,
      layers,
      timestamp,
      durationSeconds,
      zeroCrossings,
      playbackDirection,
    } = event.data;

    switch (type) {
      case "voice:reset":
        this.#resetState();
        this.port.postMessage({ type: "voice:reset" });
        break;

      case "voice:setBuffer":
      case "voice:setLayers": {
        // Both messages replace the entire layer set, so state resets exactly
        // once and there is no partially-loaded window to get wrong.
        this.#resetState();
        this.zeroCrossings = [];
        this.minZeroCrossing = 0;
        this.maxZeroCrossing = 0;

        this.layers = (layers ?? (buffer ? [buffer] : [])).filter(Boolean);
        // ponytail: 1/L is correct for fully coherent layers (the same sample
        // stacked) and 3dB conservative otherwise. Add per-layer user gain
        // when a UI needs it.
        this.layerGain = this.layers.length ? 1 / this.layers.length : 1;

        this.port.postMessage({
          type: "voice:loaded",
          durationSeconds,
          time: currentTime,
        });
        break;
      }

      case "voice:setZeroCrossings":
        this.zeroCrossings = (zeroCrossings || []).map((timeSec) => timeSec * sampleRate);

        // Set min/max zero crossings for parameter constraints
        if (this.zeroCrossings.length > 0) {
          this.minZeroCrossing = this.zeroCrossings[0];
          this.maxZeroCrossing = this.zeroCrossings[this.zeroCrossings.length - 1];
        }
        break;

      case "voice:start":
        this.isReleasing = false;
        this.isPlaying = true;
        this.loopCount = 0;

        // will be set in process() using parameters
        this.playbackPosition = 0;

        this.port.postMessage({
          type: "voice:started",
          time: timestamp || currentTime,
        });
        break;

      case "voice:release":
        this.isReleasing = true;

        this.port.postMessage({
          type: "voice:releasing",
          time: currentTime,
        });
        break;

      case "voice:stop":
        this.#stop();
        break;

      case "setLoopEnabled":
        this.loopEnabled = value;

        this.port.postMessage({
          type: "loop:enabled",
          enabled: value,
        });
        break;

      case "setPanDriftEnabled":
        this.panDriftEnabled = value;
        break;

      case "voice:setPlaybackDirection": {
        const reverse = playbackDirection === "reverse";

        // Reverse interpolation reads ~1 sample behind forward at the same
        // position; shift so the emitted value stays continuous across the flip.
        if (reverse !== this.reversePlayback && this.playbackPosition > 0) {
          this.playbackPosition += reverse ? 1 : -1;
        }
        this.reversePlayback = reverse;

        this.port.postMessage({
          type: "voice:playbackDirectionChange",
          playbackDirection,
        });
        break;
      }

      case "voice:usePlaybackPosition":
        this.usePlaybackPosition = value;
        break;

      case "syncLoopToTempo":
        this.syncLoopToTempo = value;

        this.port.postMessage({
          type: "loop:syncToTempo",
          enabled: value,
        });
        break;

      case "setKeytrackLoopAmount":
        this.keytrackLoopAmount = Math.max(0, Math.min(1, value));
        break;

      case "setPreserveDuration":
        this.durationPreserver.setEnabled(value, this.playbackPosition);
        break;
    }
  }

  // ===== METHODS =====

  #resetState() {
    this.isPlaying = false;
    this.isReleasing = false;
    this.loopEnabled = false;
    this.velocitySensitivity = 1.0; // full velocity = unity gain

    this.reversePlayback = false;
    this.playbackPosition = 0;

    this.debugCounter = 0;
    this.loopCount = 0;

    this.applyClickCompensation = false;
    this.loopClickCompensation = 0;

    // Loop & Pan drift feature
    this.driftUpdateCounter = 0;
    this.currentLoopDrift = 0;
    this.currentPanDrift = 0;
    this.panDriftEnabled = true;
    this.nextDriftGenerated = false;

    // Amplitude compensation for short loops
    this.loopAmplitudeGain = 1.0;
    this.lastAnalyzedLoopStart = -1;
    this.lastAnalyzedLoopEnd = -1;

    this.durationPreserver.reset();
  }

  #stop() {
    this.isPlaying = false;
    this.isReleasing = false;
    this.playbackPosition = 0;
    this.port.postMessage({ type: "voice:stopped" });
  }

  // Arm click compensation for a loop-wrap discontinuity between the sample
  // just emitted and the first sample of the next pass.
  #smoothLoopWrap(lastLoopSample, newFirstSample, loopDurationSamples, playbackRate) {
    const isHighRateAudioLoop =
      loopDurationSamples <= this.PITCH_PRESERVATION_THRESHOLD && Math.abs(playbackRate) > 1;

    if (isHighRateAudioLoop) return;

    const discontinuity = lastLoopSample - newFirstSample;

    if (this.enableLoopSmoothing && Math.abs(discontinuity) > 0.01) {
      // Simple exponential smoothing
      this.loopClickCompensation = discontinuity * 0.5;
      this.compensationDecay = 0.9; // Smooth over ~32 samples
      this.applyClickCompensation = true;
    }
  }

  #findNearestZeroCrossing(position, direction = "any", maxDistance = null) {
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
  #getMusicalNoteDurations(tempo) {
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
   * Quantize loop duration to nearest musical interval (skips if below the smallest quantize option)
   * @param {number} loopDurationSamples - Current loop duration in samples
   * @param {number} tempo - Current tempo in BPM
   * @param {number} playbackRate - Current playback rate
   * @returns {number} - Quantized loop duration in samples
   */
  #quantizeLoopDuration(loopDurationSamples, tempo, playbackRate) {
    if (!this.syncLoopToTempo) {
      return loopDurationSamples;
    }

    const noteDurations = this.#getMusicalNoteDurations(tempo);

    // Account for playback rate - faster playback means shorter effective duration
    const effectiveDuration = loopDurationSamples / Math.abs(playbackRate);

    // Find the smallest quantize option (32nd note)
    const smallestInterval = noteDurations.thirtySecond;

    // Skip quantization if the base duration is smaller than the smallest option
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
      loopStartSamples: Math.floor(parameters.loopStart[0] * sampleRate),
      loopEndSamples: Math.floor(parameters.loopEnd[0] * sampleRate),
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

    const start = Math.max(0, params.startPointSamples);
    const end =
      params.endPointSamples > start
        ? Math.min(bufferLength, params.endPointSamples)
        : bufferLength;

    const snappedStart = this.#findNearestZeroCrossing(start, "right"); // Snap forward
    const snappedEnd = this.#findNearestZeroCrossing(end, "left"); // Snap backward

    return {
      startSamples: snappedStart,
      endSamples: snappedEnd,
      durationSamples: snappedEnd - snappedStart,
    };
  }

  /**
   * Calculate effective loop range in samples with optional drift
   * @param {Object} params - Position parameters from #extractPositionParams
   * @param {Object} playbackRange - Range from #calculatePlaybackRange
   * @param {number} driftAmount - Loop duration drift amount (0-1)
   * @param {number} tempo - Current tempo in BPM
   * @param {number} playbackRate - Current playback rate
   * @returns {Object} - Effective loop start and end positions with drift applied
   */
  #calculateLoopRange(params, playbackRange, driftAmount = 0, tempo = 120, playbackRate = 1) {
    const lpStart = params.loopStartSamples;
    const lpEnd = params.loopEndSamples;

    // Default to playback range if loop points are not set
    let calcLoopStart = lpStart < lpEnd && lpStart >= 0 ? lpStart : playbackRange.startSamples;

    let calcLoopEnd =
      lpEnd > lpStart && lpEnd <= playbackRange.endSamples ? lpEnd : playbackRange.endSamples;

    let baseDuration = calcLoopEnd - calcLoopStart;

    // Apply tempo quantization if enabled
    if (this.syncLoopToTempo) {
      const quantizedDuration = this.#quantizeLoopDuration(baseDuration, tempo, playbackRate);

      calcLoopEnd = calcLoopStart + quantizedDuration;
      // Ensure we don't exceed playback range
      calcLoopEnd = Math.min(calcLoopEnd, playbackRange.endSamples);
    }

    // Keytrack loop: scale sample-domain loop length by playbackRate so the real-time
    // loop period stays constant across notes (amount=1); amount=0 leaves it fixed.
    // Keytrack and tempo-sync both remap loop length as a function of playbackRate, in
    // opposite directions (real-time vs. musical length). They are mutually exclusive:
    // tempo-sync wins whenever it is enabled, even when quantization left the
    // duration unchanged (already on-grid, or too short to quantize).
    if (
      baseDuration > this.PITCH_PRESERVATION_THRESHOLD &&
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

    // Only snap to zero crossing if it doesnt affect pitch (audio-rate loop duration)
    if (baseDuration > this.PITCH_PRESERVATION_THRESHOLD) {
      calcLoopStart = this.#findNearestZeroCrossing(calcLoopStart, "right");
    }

    // Apply drift to loop end position
    if (driftAmount > 0 && this.loopEnabled) {
      // Generate new drift only at the start of each loop iteration
      if (!this.nextDriftGenerated || this.loopCount === 0) {
        // For short loops (audio-rate), update drift less frequently
        const updateInterval =
          baseDuration <= this.PITCH_PRESERVATION_THRESHOLD
            ? Math.max(1, Math.floor(this.PITCH_PRESERVATION_THRESHOLD / baseDuration))
            : 1;

        const shouldUpdateDrift = this.driftUpdateCounter % updateInterval === 0;

        if (shouldUpdateDrift) {
          this.currentLoopDrift = this.#generateLoopDrift(driftAmount, baseDuration);

          if (this.panDriftEnabled && driftAmount > 0 && this.loopCount > 0) {
            const panDriftAmountScalar = 0.0001;
            this.currentPanDrift = this.currentLoopDrift * panDriftAmountScalar;
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
    if (
      baseDuration > this.PITCH_PRESERVATION_THRESHOLD &&
      calcLoopEnd <= playbackRange.endSamples
    ) {
      calcLoopEnd = Math.max(calcLoopStart + 1, this.#findNearestZeroCrossing(calcLoopEnd, "left"));
    }

    const loopDuration = calcLoopEnd - calcLoopStart;

    return {
      loopStartSamples: calcLoopStart,
      loopEndSamples: calcLoopEnd,
      loopDurationSamples: loopDuration,
    };
  }

  #getSafeParam(paramArray, index, isConstant) {
    return isConstant ? paramArray[0] : paramArray[Math.min(index, paramArray.length - 1)];
  }

  #getConstantFlags(parameters) {
    this.constantFlags ??= {
      envGain: true,
      playbackRate: true,
    };

    this.constantFlags.envGain = parameters.envGain.length === 1;
    this.constantFlags.playbackRate = parameters.playbackRate.length === 1;

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

    return Math.floor(randomFactor * maxDriftSamples);
  }

  /**
   * Analyze loop amplitude and calculate makeup gain for short loops
   * @param {number} loopStart - Loop start position in samples
   * @param {number} loopEnd - Loop end position in samples
   * @returns {number} - Makeup gain multiplier (1.0 = no change)
   */
  #analyzeLoopAmplitude(loopStart, loopEnd) {
    if (!this.enableAmplitudeCompensation || !this.buffer || !this.buffer[0]) {
      return 1.0;
    }

    const loopDuration = loopEnd - loopStart;

    // Only analyze very short loops (shorter than C3 period)
    if (loopDuration >= this.AMPLITUDE_COMPENSATION_THRESHOLD) {
      return 1.0;
    }

    // Skip if we already analyzed this exact loop range
    if (loopStart === this.lastAnalyzedLoopStart && loopEnd === this.lastAnalyzedLoopEnd) {
      return this.loopAmplitudeGain;
    }

    // Calculate RMS amplitude of the loop
    let sumSquares = 0;
    let sampleCount = 0;

    // Analyze first channel only for simplicity
    const channel = this.buffer[0];
    const startIndex = Math.floor(loopStart);
    const endIndex = Math.floor(loopEnd);

    for (let i = startIndex; i < endIndex && i < channel.length; i++) {
      const sample = channel[i];
      sumSquares += sample * sample;
      sampleCount++;
    }

    if (sampleCount === 0) return 1.0;

    const rmsAmplitude = Math.sqrt(sumSquares / sampleCount);

    // if the amplitude is below the target, we apply makeup gain to bring it closer
    const targetAmplitude = 0.3;

    // Calculate makeup gain, but limit it to reasonable range
    let makeupGain = 1.0;
    if (rmsAmplitude < targetAmplitude) {
      // Use a minimum floor to avoid division by very small numbers
      // This prevents huge gain values that would cause artifacts
      const safeRms = Math.max(rmsAmplitude, 1e-3);
      makeupGain = targetAmplitude / safeRms;
      // Limit gain to reasonable range
      makeupGain = Math.min(2.0, makeupGain);
    }

    // Cache the result
    this.lastAnalyzedLoopStart = loopStart;
    this.lastAnalyzedLoopEnd = loopEnd;
    this.loopAmplitudeGain = makeupGain;

    return makeupGain;
  }

  // ===== MAIN PROCESS METHOD =====

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    this.debugCounter++;

    if (!output || !this.isPlaying || !this.buffer?.[0]?.length) {
      return true;
    }

    // ===== GET PARAM VALUES =====

    const masterGain = parameters.masterGain[0];

    const positionParams = this.#extractPositionParams(parameters);

    const playbackRange = this.#calculatePlaybackRange(positionParams);

    // Loop-length math needs the rate playback actually advances at
    const effectivePlaybackRate = parameters.playbackRate[0];

    const tempo = parameters.tempo[0];

    const loopRange = this.#calculateLoopRange(
      positionParams,
      playbackRange,
      parameters.loopDurationDriftAmount[0],
      tempo,
      effectivePlaybackRate,
    );

    const durationPreservationActive = this.durationPreserver.isActive(
      this.zeroCrossings,
      this.loopEnabled,
      loopRange.loopDurationSamples,
      this.PITCH_PRESERVATION_THRESHOLD,
    );

    // Calculate amplitude compensation for short loops
    const amplitudeGain = this.#analyzeLoopAmplitude(
      loopRange.loopStartSamples,
      loopRange.loopEndSamples,
    );

    const velocityGain =
      this.#midiVelocityToGain(parameters.velocity[0]) * this.velocitySensitivity;

    // EXPERIMENTAL: Apply pan drift if enabled
    const basePan = parameters.pan[0];
    const effectivePan = this.panDriftEnabled
      ? Math.max(-1, Math.min(1, basePan + this.currentPanDrift))
      : basePan;

    // Handle different output structures
    let outputChannels;
    if (output instanceof Float32Array) {
      // Case 1: output is a single Float32Array (mono output - legacy)
      outputChannels = [output];
    } else if (Array.isArray(output) && output.every((ch) => ch instanceof Float32Array)) {
      // Case 2: output is array of Float32Arrays (stereo/multi-channel output)
      outputChannels = output;
    } else {
      console.error("Unexpected output structure:", {
        outputType: typeof output,
        isArray: Array.isArray(output),
        constructor: output?.constructor?.name,
        length: output?.length,
      });
      return true;
    }

    const numChannels = outputChannels.length; // Always process all output channels

    const isConstant = this.#getConstantFlags(parameters);

    // Keytracked loop longer than the available audio: pad the tail with silence so
    // the loop period stays constant. Fade the last few ms so a sample ending on a
    // non-zero value doesn't click into the silence.
    const silencePadTail = loopRange.loopEndSamples > playbackRange.endSamples;
    const TAIL_FADE_SAMPLES = 64;

    // ===== Init playback position =====

    if (this.playbackPosition === 0) {
      this.playbackPosition = this.reversePlayback
        ? playbackRange.endSamples - 1
        : playbackRange.startSamples;
      this.durationPreserver.reset(this.playbackPosition);
    }

    // ===== AUDIO PROCESSING =====

    for (let sample = 0; sample < outputChannels[0].length; sample++) {
      // Use getSafeParam for a-rate params
      const envelopeGain = this.#getSafeParam(parameters.envGain, sample, isConstant.envGain);

      const baseRate = this.#getSafeParam(parameters.playbackRate, sample, isConstant.playbackRate);

      const playbackStep = this.reversePlayback ? -Math.abs(baseRate) : Math.abs(baseRate);

      // Handle looping
      const canWrapLoop = this.loopEnabled && this.loopCount < parameters.maxLoopCount[0];
      if (canWrapLoop) {
        if (!this.reversePlayback && this.playbackPosition >= loopRange.loopEndSamples) {
          // Get the actual samples we're transitioning between
          // In the silent tail the buffer still holds audio we aren't outputting,
          // so the sample we actually just emitted is 0.
          this.#smoothLoopWrap(
            silencePadTail ? 0 : this.buffer[0][Math.floor(this.playbackPosition - 1)] || 0,
            this.buffer[0][Math.floor(loopRange.loopStartSamples)] || 0,
            loopRange.loopDurationSamples,
            baseRate,
          );

          const overshoot = this.playbackPosition - loopRange.loopEndSamples;
          this.playbackPosition = loopRange.loopStartSamples + overshoot;
          this.loopCount++;

          // Reset drift flag to generate new drift for next loop iteration
          this.nextDriftGenerated = false;
        }
        // Reverse playback
        else if (this.reversePlayback && this.playbackPosition <= loopRange.loopStartSamples) {
          // Mirror of the forward wrap: last emitted sample sits at the loop
          // start, the next pass begins at the loop end (0 in the silent tail).
          this.#smoothLoopWrap(
            this.buffer[0][Math.floor(loopRange.loopStartSamples)] || 0,
            silencePadTail ? 0 : this.buffer[0][Math.floor(loopRange.loopEndSamples) - 1] || 0,
            loopRange.loopDurationSamples,
            baseRate,
          );

          const underflow = loopRange.loopStartSamples - this.playbackPosition;
          this.playbackPosition = loopRange.loopEndSamples - underflow;
          this.loopCount++;

          // Reset drift flag to generate new drift for next loop iteration
          this.nextDriftGenerated = false;
        }
      }

      const durationCorrection = this.durationPreserver.prepareCorrection(
        durationPreservationActive,
        this.playbackPosition,
        playbackStep,
        this.zeroCrossings,
        this.buffer[0],
      );
      const durationResetTarget = durationCorrection?.resetTarget ?? null;
      if (durationCorrection) this.playbackPosition = durationCorrection.outgoingPosition;

      // Check for end of playback range (forward & reversed)
      // Don't stop if we're looping and within the playback range
      const shouldStopForward =
        !this.reversePlayback &&
        (durationPreservationActive
          ? this.durationPreserver.timelinePosition
          : this.playbackPosition) >= playbackRange.endSamples;
      const shouldStopReverse =
        this.reversePlayback &&
        (durationPreservationActive
          ? this.durationPreserver.timelinePosition
          : this.playbackPosition) <= playbackRange.startSamples;
      const isWithinLoop =
        this.loopEnabled &&
        this.playbackPosition >= loopRange.loopStartSamples &&
        this.playbackPosition <= loopRange.loopEndSamples;

      if ((shouldStopForward || shouldStopReverse) && !(this.loopEnabled && isWithinLoop)) {
        this.#stop();
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

      // Sample interpolation
      const currentPosition = Math.floor(this.playbackPosition);
      const positionOffset = this.playbackPosition - currentPosition;

      // Pre-calculate interpolation positions outside channel loop
      let nextPosition, interpWeight;
      if (this.reversePlayback) {
        nextPosition = Math.max(currentPosition - 1, playbackRange.startSamples);
        interpWeight = 1 - positionOffset; // Reverse: weight toward previous sample
      } else {
        nextPosition = Math.min(currentPosition + 1, playbackRange.endSamples - 1);
        interpWeight = positionOffset; // Forward: weight toward next sample
      }

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

        // Sum every loaded layer at the shared playhead. Mono layers use
        // channel 0 for both outputs; layers shorter than the authority read
        // past their end and contribute 0.
        // ponytail: one shared position for all layers, so layers play in
        // unison. Per-layer detune means a position per layer here (or baking
        // the transposition into the buffer at load).
        let interpolatedSample = 0;
        for (let l = 0; l < this.layers.length; l++) {
          const layer = this.layers[l];
          const layerChannel = layer[Math.min(channel, layer.length - 1)];

          // Linear interpolation between current and next positions
          const currentSample = layerChannel[currentPosition] || 0;
          const nextSample = layerChannel[nextPosition] || 0;
          interpolatedSample +=
            (currentSample + interpWeight * (nextSample - currentSample)) * this.layerGain;
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

        const finalSample =
          interpolatedSample * velocityGain * envelopeGain * masterGain * amplitudeGain * tailGain;

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

    // Send position updates if requested
    if (this.usePlaybackPosition) {
      const normalizedPosition = this.#samplesToNormalized(this.playbackPosition);
      this.port.postMessage({
        type: "voice:position",
        position: normalizedPosition,
      });
    }

    return true;
  }
}

registerProcessor("sample-player-processor", SamplePlayerProcessor);
