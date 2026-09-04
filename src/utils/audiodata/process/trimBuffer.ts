/**
 * Ramp `lengthSamples` of `channelData` in place, starting at `startSample`.
 *
 * The ramp is always shaped over the full `lengthSamples`, so a fade running
 * past the end of the array is cut short rather than squeezed to fit.
 */
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

/**
 * Shortest fade that still hides a cut, in samples.
 *
 * ~0.2ms is where a raised cosine stops splattering audibly. The 8-sample floor
 * takes over below ~40kHz, where 0.2ms is too few points to shape a ramp.
 */
export function minFadeSamples(sampleRate: number) {
  return Math.max(Math.ceil(0.0002 * sampleRate), 8);
}

/**
 * Fade length per side, in milliseconds. "default" is the shortest fade that
 * still hides a cut at the buffer's sample rate; 0 skips that side.
 */
export type FadeMs = { in: number | "default"; out: number | "default" };

/**
 * Copy samples [start, end) into a new buffer, fading each edge so the cut
 * doesn't click.
 *
 * If the two fades would overlap in the trimmed length, neither is applied.
 */
export function trimAudioBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  start: number,
  end: number,
  fadeMs: FadeMs,
) {
  const numChannels = buffer.numberOfChannels;
  const newLength = end - start;
  const trimmedBuffer = ctx.createBuffer(numChannels, newLength, buffer.sampleRate);

  const toSamples = (ms: number | "default") =>
    ms === "default"
      ? minFadeSamples(buffer.sampleRate)
      : Math.max(0, Math.floor((ms / 1000) * buffer.sampleRate));

  const fadeInSamples = toSamples(fadeMs.in);
  const fadeOutSamples = toSamples(fadeMs.out);

  for (let ch = 0; ch < numChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const output = trimmedBuffer.getChannelData(ch);

    // Copy data
    for (let i = 0; i < newLength; i++) {
      output[i] = input[start + i];
    }

    // Fade only if the ramps fit. Equal is fine: they abut, they don't overlap,
    // and a disabled side contributes 0, so one fade may fill the whole buffer.
    if (fadeInSamples + fadeOutSamples <= newLength) {
      if (fadeInSamples > 0) applyFade(output, 0, fadeInSamples, "in");
      if (fadeOutSamples > 0) applyFade(output, newLength - fadeOutSamples, fadeOutSamples, "out");
    }
  }

  return trimmedBuffer;
}
