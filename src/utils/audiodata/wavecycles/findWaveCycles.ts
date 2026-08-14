const DEFAULT_THRESHOLD = 0.0001;

export function findWaveCycles(
  audioBuffer: AudioBuffer,
  threshold: number = DEFAULT_THRESHOLD
): Array<{
  startTime: number;
  endTime: number;
  startSample: number;
  endSample: number;
}> {
  const channel = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  // Build zero crossings with direction (+ going up through zero, - going down)
  const zc: Array<{ t: number; dir: 1 | -1 }> = [];
  for (let i = 1; i < channel.length; i++) {
    const a = channel[i - 1],
      b = channel[i];
    if (Math.abs(b) < threshold) {
      zc.push({ t: i / sr, dir: (Math.sign(b) as 1 | -1) || 1 });
    } else if (Math.sign(a) !== Math.sign(b)) {
      const t = -a / (b - a);
      const time = (i - 1 + t) / sr;
      const dir = (b > a ? 1 : -1) as 1 | -1;
      zc.push({ t: time, dir });
    }
  }

  const cycles: Array<{
    startTime: number;
    endTime: number;
    startSample: number;
    endSample: number;
  }> = [];
  // Pair zero-crossings of the same direction (one full waveform period)
  for (let i = 0; i < zc.length - 2; i++) {
    const a = zc[i];
    const c = zc[i + 2];
    if (a.dir === c.dir) {
      const startTime = a.t;
      const endTime = c.t;
      cycles.push({
        startTime,
        endTime,
        startSample: Math.floor(startTime * sr),
        endSample: Math.floor(endTime * sr),
      });
    }
  }

  // Fallback: if too few directional pairs, use previous simple pairing
  if (cycles.length === 0 && zc.length > 1) {
    for (let i = 0; i < zc.length - 1; i += 2) {
      const startTime = zc[i].t;
      const endTime = zc[i + 1].t;
      cycles.push({
        startTime,
        endTime,
        startSample: Math.floor(startTime * sr),
        endSample: Math.floor(endTime * sr),
      });
    }
  }

  return cycles;
}

export function duplicateWaveCycles(
  audioBuffer: AudioBuffer,
  numCycles: number
): AudioBuffer {
  // Find all wave cycles in the original buffer
  const cycles = findWaveCycles(audioBuffer);

  if (cycles.length === 0) {
    // No cycles found, return original buffer
    return audioBuffer;
  }

  // Calculate total length needed for duplicated cycles
  let totalSamples = 0;
  for (const cycle of cycles) {
    const cycleLength = cycle.endSample - cycle.startSample;
    totalSamples += cycleLength * numCycles;
  }

  // Create new AudioBuffer with calculated length
  const newBuffer = new AudioBuffer({
    numberOfChannels: audioBuffer.numberOfChannels,
    length: totalSamples,
    sampleRate: audioBuffer.sampleRate,
  });

  // Process each channel
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const sourceData = audioBuffer.getChannelData(ch);
    const targetData = newBuffer.getChannelData(ch);

    let writeIndex = 0;

    // For each detected cycle
    for (const cycle of cycles) {
      const cycleLength = cycle.endSample - cycle.startSample;

      // Duplicate this cycle numCycles times
      for (let duplication = 0; duplication < numCycles; duplication++) {
        // Copy the cycle data
        for (let i = 0; i < cycleLength; i++) {
          if (
            writeIndex < targetData.length &&
            cycle.startSample + i < sourceData.length
          ) {
            targetData[writeIndex] = sourceData[cycle.startSample + i];
            writeIndex++;
          }
        }
      }
    }
  }

  return newBuffer;
}
