// For standard PCM WAV files (e.g. to get the needed info to create an OfflineAudioContext)
// todo: test before using
export function parseWavHeader(arrayBuffer: ArrayBuffer) {
  const view = new DataView(arrayBuffer);

  // Number of channels: bytes 22-23
  const numberOfChannels = view.getUint16(22, true);

  // Sample rate: bytes 24-27
  const sampleRate = view.getUint32(24, true);

  // Bits per sample: bytes 34-35
  const bitsPerSample = view.getUint16(34, true);

  // Subchunk2Size (data size): bytes 40-43
  const subchunk2Size = view.getUint32(40, true);

  // Length (samples per channel)
  const length = subchunk2Size / (numberOfChannels * (bitsPerSample / 8));

  return {
    length,
    numberOfChannels,
    sampleRate,
  };
}
