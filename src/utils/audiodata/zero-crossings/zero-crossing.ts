// zero-crossing.ts

const DEFAULT_THRESHOLD = 0.0001;

/** Returns a sorted array of zero crossing time point in seconds */
export function findZeroCrossingSeconds(
  audioBuffer: AudioBuffer,
  threshold: number = DEFAULT_THRESHOLD
): number[] {
  const channel = audioBuffer.getChannelData(0); // Always use the first channel (left if stereo)
  const sampleRate = audioBuffer.sampleRate;
  const zeroCrossings: number[] = [];

  for (let i = 1; i < channel.length; i++) {
    if (Math.abs(channel[i]) < threshold) {
      // Sample is already very close to zero
      zeroCrossings.push(i / sampleRate);
    } else if (Math.sign(channel[i]) !== Math.sign(channel[i - 1])) {
      // Sign change detected, perform linear interpolation
      const t = -channel[i - 1] / (channel[i] - channel[i - 1]);
      const zeroCrossingTime = (i - 1 + t) / sampleRate;
      zeroCrossings.push(zeroCrossingTime);
    }
  }

  return zeroCrossings;
}

/** Returns a sorted array of zero crossing sample indices */
export function findZeroCrossingSamples(
  audioBuffer: AudioBuffer,
  threshold: number = DEFAULT_THRESHOLD
): number[] {
  const channel = audioBuffer.getChannelData(0);
  const zeroCrossings: number[] = [];

  for (let i = 1; i < channel.length; i++) {
    if (Math.abs(channel[i]) < threshold) {
      zeroCrossings.push(i);
    } else if (Math.sign(channel[i]) !== Math.sign(channel[i - 1])) {
      // Linear interpolation for fractional crossing, but return nearest integer index
      const t = -channel[i - 1] / (channel[i] - channel[i - 1]);
      const zeroCrossingIndex = Math.round(i - 1 + t);
      zeroCrossings.push(zeroCrossingIndex);
    }
  }

  return zeroCrossings;
}

// TODO: Use binary search version
export function snapToNearestZeroCrossing(
  currTimeSec: number, // Seconds from start of audio buffer
  zeroCrossings: number[]
): number {
  if (zeroCrossings.length === 0) {
    console.warn('No zero crossings found');
    return currTimeSec;
  }

  return zeroCrossings.reduce((prev, curr) =>
    Math.abs(curr - currTimeSec) < Math.abs(prev - currTimeSec) ? curr : prev
  );
}

// Usage
// const zeroCrossings = findZeroCrossings(audioBuffer);
// loopStart = snapToNearestZeroCrossing(userSelectedLoopStart, zeroCrossings);
// loopEnd = snapToNearestZeroCrossing(userSelectedLoopEnd, zeroCrossings);
