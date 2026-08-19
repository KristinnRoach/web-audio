// Preprocessor.ts
import { normalizeAudioBuffer } from "@/utils/audiodata/process/normalizeAudioBuffer";
import { compressAudioBuffer } from "@/utils/audiodata/process/compressAudioBuffer";
import { shouldCompress } from "@/utils/audiodata/process/shouldCompress";
import { detectThresholdCrossing } from "@/utils/audiodata/process/detectSilence";
import { trimAudioBuffer } from "@/utils/audiodata/process/trimBuffer";
import { detectSinglePitchAC } from "@/utils/audiodata/pitchDetection";
import { findClosestNote } from "@/utils";
import { findZeroCrossingSeconds } from "@/utils";

export type PreProcessOptions = {
  skipPreProcessing?: boolean;
  normalize?: { enabled: boolean; maxAmplitudePeak?: number }; // amplitude range [-1, 1]
  compress?: {
    enabled: boolean;
    threshold?: number;
    ratio?: number;
    makeupGain?: number;
  }; // dynamic range compression
  trimSilence?: { enabled: boolean; threshold?: number };
  fadeInOutMs?: number; // milliseconds
  tune?: { detectPitch?: boolean; autotune: boolean; targetMidiNote?: number };
  hpf?: { auto?: boolean } | { cutoff?: number }; // auto starts filtering at detected fundamental if within range 30-350 (below)
  getZeroCrossings?: boolean;
};

export const DEFAULT_PRE_PROCESS_OPTIONS: PreProcessOptions = {
  normalize: { enabled: true, maxAmplitudePeak: 0.99 }, // amplitude range [-1, 1]
  compress: { enabled: true },
  trimSilence: { enabled: true, threshold: 0.005 },
  fadeInOutMs: 1, // milliseconds
  tune: { detectPitch: true, autotune: true, targetMidiNote: 60 },
  hpf: { auto: true },
  getZeroCrossings: true,
} as const;

export type PreProcessResults = {
  audiobuffer: AudioBuffer;
  detectedPitch?: {
    fundamentalHz: number;
    transpositionSemitones?: number;
    confidence: number;
  };
  zeroCrossings?: number[];
};

export async function preProcessAudioBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  options: Partial<PreProcessOptions> = {},
): Promise<PreProcessResults> {
  const {
    fadeInOutMs = DEFAULT_PRE_PROCESS_OPTIONS.fadeInOutMs,
    hpf = DEFAULT_PRE_PROCESS_OPTIONS.hpf,
    getZeroCrossings = DEFAULT_PRE_PROCESS_OPTIONS.getZeroCrossings,
  } = options;

  if (options.skipPreProcessing) {
    const finalResults: PreProcessResults = { audiobuffer: buffer };
    if (getZeroCrossings) {
      const zeroes = findZeroCrossingSeconds(buffer);
      finalResults.zeroCrossings = zeroes;
    }
    return finalResults;
  }

  const normalize = {
    ...DEFAULT_PRE_PROCESS_OPTIONS.normalize,
    ...(options.normalize || {}),
  };
  const compress = {
    ...DEFAULT_PRE_PROCESS_OPTIONS.compress,
    ...(options.compress || {}),
  };
  const trimSilence = {
    ...DEFAULT_PRE_PROCESS_OPTIONS.trimSilence,
    ...(options.trimSilence || {}),
  };
  const tune = {
    ...DEFAULT_PRE_PROCESS_OPTIONS.tune,
    ...(options.tune || {}),
  };
  let processed = buffer;
  let results: Partial<PreProcessResults> = {};

  const PITCH_CONFIDENCE_THRESHOLD = 0.35;

  if (trimSilence?.enabled) {
    const { start, end } = detectThresholdCrossing(processed, trimSilence.threshold ?? 0.01);
    processed = trimAudioBuffer(ctx, processed, start, end, fadeInOutMs);
  }

  // Apply HPF first (before normalization) to avoid filter-induced clipping
  if (hpf) {
    if ("cutoff" in hpf) {
      processed = await applyHighPassFilter(processed, hpf.cutoff ?? 80);
    } else if ("auto" in hpf && hpf.auto) {
      // For auto HPF, we need pitch detection first
      const tempPitch = await detectPitch(processed);
      if (tempPitch.confidence >= PITCH_CONFIDENCE_THRESHOLD) {
        const cutoffFreq =
          tempPitch.frequency > 30 && tempPitch.frequency < 350 ? tempPitch.frequency : 80;
        processed = await applyHighPassFilter(processed, cutoffFreq);
      }
    }
  }

  if (normalize?.enabled) {
    processed = normalizeAudioBuffer(ctx, processed, normalize.maxAmplitudePeak);
  }

  if (compress?.enabled) {
    // Smart compression: check if audio needs it
    const compressionAnalysis = shouldCompress(processed);

    if (compressionAnalysis.shouldCompress) {
      // Only use manual overrides if explicitly provided (not from defaults)
      const hasManualSettings =
        compress.threshold !== undefined ||
        compress.ratio !== undefined ||
        compress.makeupGain !== undefined;

      let settings;
      if (hasManualSettings && compress.threshold !== undefined) {
        // User explicitly provided settings, use them
        settings = {
          threshold: compress.threshold ?? 0.5,
          ratio: compress.ratio ?? 2,
          makeupGain: compress.makeupGain ?? 1.0,
        };
      } else {
        // Use smart suggested settings from analysis
        settings = compressionAnalysis.suggestedSettings!;
      }

      processed = compressAudioBuffer(
        ctx,
        processed,
        settings.threshold,
        settings.ratio,
        settings.makeupGain,
      );
    }
  }

  if (tune?.detectPitch || tune?.autotune || (hpf && "auto" in hpf && hpf.auto)) {
    const detectedPitch = await detectPitch(processed);
    // Use target MIDI note 60 (C4) or a provided target note
    const targetMidiNote = tune?.targetMidiNote || 60;
    const transposeSemitones = detectedPitchToTransposition(
      detectedPitch.midiFloat,
      targetMidiNote,
    );

    results.detectedPitch = {
      fundamentalHz: detectedPitch.frequency,
      transpositionSemitones: transposeSemitones,
      confidence: detectedPitch.confidence,
    };
  }

  if (tune?.autotune) {
    if (
      !results.detectedPitch?.transpositionSemitones ||
      results.detectedPitch.confidence < PITCH_CONFIDENCE_THRESHOLD
    ) {
      console.info("Skipped autotune due to unreliable pitch detection");
    } else if (Math.abs(results.detectedPitch?.transpositionSemitones ?? 0) < 0.1) {
      console.info("Skipped autotune - detected pitch is already C");
    } else {
      processed = resampleForPitch(ctx, processed, results.detectedPitch.transpositionSemitones);
    }
  }

  if (normalize?.enabled) {
    processed = normalizeAudioBuffer(ctx, processed, normalize.maxAmplitudePeak);
  }

  if (getZeroCrossings) {
    const zeroes = findZeroCrossingSeconds(processed);
    results.zeroCrossings = zeroes;
  }

  const finalResults: PreProcessResults = {
    ...results,
    audiobuffer: processed,
  };

  return finalResults;
}

/**
 * Resamples an audio buffer to change its pitch by the specified semitone offset
 * @param ctx AudioContext to create the new buffer
 * @param buffer The source audio buffer
 * @param semitones The number of semitones to transpose (-6 to +6 recommended)
 * @returns A new audio buffer with adjusted pitch
 */
function resampleForPitch(ctx: AudioContext, buffer: AudioBuffer, semitones: number): AudioBuffer {
  // Calculate playback rate based on semitone difference
  const playbackRate = Math.pow(2, semitones / 12);

  // Calculate new buffer length
  const oldLength = buffer.length;
  const newLength = Math.round(oldLength / playbackRate);

  // Create a new buffer
  const newBuffer = ctx.createBuffer(buffer.numberOfChannels, newLength, buffer.sampleRate);

  // Resample each channel
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const oldData = buffer.getChannelData(channel);
    const newData = newBuffer.getChannelData(channel);

    for (let i = 0; i < newLength; i++) {
      // Simple linear interpolation for resampling
      const oldIndex = i * playbackRate;
      const oldIndexFloor = Math.floor(oldIndex);
      const fraction = oldIndex - oldIndexFloor;

      // Boundary check
      if (oldIndexFloor + 1 < oldLength) {
        // Linear interpolation
        newData[i] =
          oldData[oldIndexFloor] * (1 - fraction) + oldData[oldIndexFloor + 1] * fraction;
      } else {
        newData[i] = oldData[oldIndexFloor];
      }
    }
  }

  return newBuffer;
}

async function detectPitch(buffer: AudioBuffer, logResults = false) {
  const pitchSource = await detectSinglePitchAC(buffer);
  const targetNoteInfo = findClosestNote(pitchSource.frequency);

  const midiFloat = 69 + 12 * Math.log2(pitchSource.frequency / 440);
  const playbackRateMultiplier = targetNoteInfo.frequency / pitchSource.frequency;

  if (logResults) {
    console.table({
      pitchSource,
      targetNoteInfo,
      playbackRateMultiplier,
      midiFloat,
    });
  }

  return {
    frequency: pitchSource.frequency,
    confidence: pitchSource.confidence,
    midiFloat,
    targetNoteInfo,
  };
}

function detectedPitchToTransposition(detectedMidiFloat: number, targetMidiNote: number) {
  let transposeSemitones = targetMidiNote - detectedMidiFloat;
  // Wrap to nearest octave (-6 to +6 semitones)
  while (transposeSemitones > 6) transposeSemitones -= 12;
  while (transposeSemitones < -6) transposeSemitones += 12;

  return transposeSemitones;
}

async function applyHighPassFilter(
  buffer: AudioBuffer,
  cutoff: number,
  q = 0.5, // Gentle slope, minimal resonance
): Promise<AudioBuffer> {
  const offlineCtx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );

  const source = offlineCtx.createBufferSource();
  const filter = offlineCtx.createBiquadFilter();

  filter.type = "highpass";
  filter.frequency.value = cutoff;
  filter.Q.value = q;

  source.buffer = buffer;
  source.connect(filter);
  filter.connect(offlineCtx.destination);

  source.start(0);

  const processedBuffer = await offlineCtx.startRendering();

  return processedBuffer;
}
