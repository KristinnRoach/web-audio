/**
 * Generates an AudioBuffer with a simple waveform for testing
 * @param context OfflineAudioContext to use for buffer creation
 * @param options Configuration options
 * @returns AudioBuffer containing the generated waveform
 */
export function generateTestBuffer(
  context: OfflineAudioContext,
  options: {
    duration?: number; // Duration in seconds
    frequency?: number; // Frequency in Hz
    type?: 'sine' | 'square' | 'sawtooth' | 'white-noise';
    channels?: number; // Number of channels
  } = {}
): AudioBuffer {
  const {
    duration = 1,
    frequency = 440,
    type = 'sine',
    channels = 1,
  } = options;

  const sampleRate = context.sampleRate;
  const length = duration * sampleRate;
  const buffer = context.createBuffer(channels, length, sampleRate);

  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      switch (type) {
        case 'square':
          data[i] = Math.sign(Math.sin(2 * Math.PI * frequency * t));
          break;
        case 'sawtooth':
          data[i] = 2 * ((frequency * t) % 1) - 1;
          break;
        case 'white-noise':
          data[i] = Math.random() * 2 - 1;
          break;
        default: // sine
          data[i] = Math.sin(2 * Math.PI * frequency * t);
      }
    }
  }

  return buffer;
}
