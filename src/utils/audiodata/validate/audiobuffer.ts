export function isValidAudioBuffer(
  buffer: AudioBuffer | null | undefined,
  logInfo = false
): boolean {
  if (buffer === null || buffer === undefined) {
    return false;
  }

  const minDuration = 0.001; // Minimum duration in seconds
  const maxDuration = 240; // Maximum duration in seconds
  const minChannels = 1;
  const maxChannels = 2; // Limited to stereo until tested with more channels

  if (buffer.duration < minDuration) {
    console.warn(
      `Audio duration is too short: ${buffer.duration} seconds. Must be longer than ${minDuration} seconds`
    );
    return false;
  }

  if (buffer.duration > maxDuration) {
    console.warn(
      `Audio duration is too long: ${buffer.duration} seconds. Must be shorter than ${maxDuration} seconds`
    );
    return false;
  }

  if (
    buffer.numberOfChannels < minChannels ||
    buffer.numberOfChannels > maxChannels
  ) {
    console.warn('Invalid number of audio channels.');
    return false;
  }

  // Check if all channels are silent
  let hasNonZeroData = false;
  let peakAmplitude = 0;
  let rmsAmplitude = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    try {
      const channelData = buffer.getChannelData(channel);
      if (!channelData || channelData.length === 0) {
        return false;
      }

      let sumSquared = 0;
      // Check for any non-zero samples and calculate peak/RMS
      for (let i = 0; i < channelData.length; i++) {
        const sampleValue = Math.abs(channelData[i]);
        if (sampleValue > 0) {
          hasNonZeroData = true;
        }
        if (sampleValue > peakAmplitude) {
          peakAmplitude = sampleValue;
        }
        sumSquared += sampleValue * sampleValue;
      }

      // Calculate RMS for this channel
      const channelRMS = Math.sqrt(sumSquared / channelData.length);
      if (channelRMS > rmsAmplitude) {
        rmsAmplitude = channelRMS;
      }

      if (hasNonZeroData) break;
    } catch (error) {
      return false;
    }
  }

  // Log amplitude information
  if (hasNonZeroData) {
    if (logInfo) {
      const peakDB = 20 * Math.log10(peakAmplitude);
      const rmsDB = 20 * Math.log10(rmsAmplitude);
      console.log(`AudioBuffer Analysis:
      Duration: ${buffer.duration} seconds
      Peak amplitude: ${peakAmplitude.toFixed(4)} (${peakDB.toFixed(1)} dB)
      RMS amplitude: ${rmsAmplitude.toFixed(4)} (${rmsDB.toFixed(1)} dB)
    `);
    }
  } else {
    console.warn('Invalid Buffer: No non-zero data.');
  }

  return hasNonZeroData;
}
