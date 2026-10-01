import { findWaveCycles } from '@/utils/audiodata/wavecycles/findWaveCycles';

/** Creates a processed buffer using the supplied context. */
export function createPitchDivideEffect(
  ctx: AudioContext,
  audioBuffer: AudioBuffer,
  divider: number = 2,
): AudioBuffer {
  const cycles = findWaveCycles(audioBuffer);
  const outputBuffer = ctx.createBuffer(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate,
  );

  const inputData = audioBuffer.getChannelData(0);
  const outputData = outputBuffer.getChannelData(0);

  for (let i = 0; i < cycles.length; i += divider) {
    const cycle = cycles[i];
    const cycleLength = cycle.endSample - cycle.startSample;

    // Stretch this cycle to fill the space of 'divider' cycles
    for (let j = 0; j < divider && i + j < cycles.length; j++) {
      const targetCycle = cycles[i + j];

      // Copy stretched cycle data
      for (let s = targetCycle.startSample; s < targetCycle.endSample; s++) {
        const sourceIndex =
          cycle.startSample +
          Math.floor(
            ((s - targetCycle.startSample) / (targetCycle.endSample - targetCycle.startSample)) *
              cycleLength,
          );
        outputData[s] = inputData[sourceIndex];
      }
    }
  }

  return outputBuffer;
}
