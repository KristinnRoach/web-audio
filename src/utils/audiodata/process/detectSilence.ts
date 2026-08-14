export function detectThresholdCrossing(
  audioBuffer: AudioBuffer,
  silenceThreshold: number,
  unit: 'seconds' | 'samples' = 'samples'
): { start: number; end: number } {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samples = Array.from({ length: numChannels }, (_, i) =>
    audioBuffer.getChannelData(i)
  );

  if (samples.length === 0 || !samples[0]) {
    throw new Error('AudioBuffer must contain at least one audio channel');
  }

  const totalSamples = samples[0].length;

  function findFromStart(): number {
    for (let i = 0; i < totalSamples; i++) {
      const maxAmplitude = Math.max(
        ...samples.map((channel) => Math.abs(channel[i]))
      );
      if (maxAmplitude > silenceThreshold) {
        return unit === 'seconds' ? i / sampleRate : i;
      }
    }
    return 0;
  }

  function findFromEnd(): number {
    for (let i = totalSamples - 1; i >= 0; i--) {
      const maxAmplitude = Math.max(
        ...samples.map((channel) => Math.abs(channel[i]))
      );
      if (maxAmplitude > silenceThreshold) {
        return unit === 'seconds' ? i / sampleRate : i;
      }
    }
    return unit === 'seconds'
      ? (totalSamples - 1) / sampleRate
      : totalSamples - 1;
  }

  return {
    start: findFromStart(),
    end: findFromEnd(),
  };
}
