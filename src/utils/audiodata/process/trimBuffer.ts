export function applyFade(
  channelData: Float32Array,
  startSample: number,
  lengthSamples: number,
  fadeType: "in" | "out",
) {
  const endSample = Math.min(startSample + lengthSamples, channelData.length);

  for (let i = startSample; i < endSample; i++) {
    const progress = (i - startSample) / lengthSamples;
    // Raised cosine: slope is continuous at both ends, so short fades don't
    // click the way a linear ramp's abrupt slope change does.
    const ramp = 0.5 - 0.5 * Math.cos(Math.PI * progress);
    channelData[i] *= fadeType === "in" ? ramp : 1 - ramp;
  }
}

export function trimAudioBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  start: number,
  end: number,
  fadeMs: number = 1,
) {
  const numChannels = buffer.numberOfChannels;
  const newLength = end - start;
  const trimmedBuffer = ctx.createBuffer(numChannels, newLength, buffer.sampleRate);

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
      applyFade(output, 0, fadeSamples, "in");
      applyFade(output, newLength - fadeSamples, fadeSamples, "out");
    }
  }

  return trimmedBuffer;
}
