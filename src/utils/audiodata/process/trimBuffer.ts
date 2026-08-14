export function applyFade(
  channelData: Float32Array,
  startSample: number,
  lengthSamples: number,
  fadeType: 'in' | 'out'
) {
  const endSample = Math.min(startSample + lengthSamples, channelData.length);

  for (let i = startSample; i < endSample; i++) {
    const progress = (i - startSample) / lengthSamples;
    const gain = fadeType === 'in' ? progress : 1 - progress;
    channelData[i] *= gain;
  }
}

export function trimAudioBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  start: number,
  end: number,
  fadeMs: number = 4
) {
  const numChannels = buffer.numberOfChannels;
  const newLength = end - start;
  const trimmedBuffer = ctx.createBuffer(
    numChannels,
    newLength,
    buffer.sampleRate
  );

  // Convert fade time to samples
  const fadeSamples = Math.floor((fadeMs / 1000) * buffer.sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const output = trimmedBuffer.getChannelData(ch);

    // Copy data
    for (let i = 0; i < newLength; i++) {
      output[i] = input[start + i];
    }

    // Apply fades if we have enough samples
    if (newLength > fadeSamples * 2 && fadeSamples > 0) {
      applyFade(output, 0, fadeSamples, 'in');
      applyFade(output, newLength - fadeSamples, fadeSamples, 'out');
    }
  }

  return trimmedBuffer;
}
