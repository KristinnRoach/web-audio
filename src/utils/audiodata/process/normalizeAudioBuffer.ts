import { copyChannelData } from '@/utils/audiodata/copyChannelData';

export function normalizeAudioBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  targetPeak = 0.9,
): AudioBuffer {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const channels = Array.from({ length: numChannels }, (_, ch) => copyChannelData(buffer, ch));
  let max = 0;

  // Find the maximum absolute sample value
  for (let ch = 0; ch < numChannels; ch++) {
    const data = channels[ch];
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > max) max = abs;
    }
  }

  // Avoid division by zero
  if (max === 0) return buffer;

  const gain = targetPeak / max;
  const normalized = ctx.createBuffer(numChannels, length, sampleRate);

  // Apply gain to each channel
  for (let ch = 0; ch < numChannels; ch++) {
    const input = channels[ch];
    const output = normalized.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      output[i] = input[i] * gain;
    }
  }

  return normalized;
}
