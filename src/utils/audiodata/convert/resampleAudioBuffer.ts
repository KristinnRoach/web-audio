/**
 * Render `buffer` at `sampleRate`, preserving channel count and duration
 * (rounded to whole frames). Returns the input unchanged when the rates
 * already match. Rejects with the browser's NotSupportedError for rates
 * OfflineAudioContext does not support.
 */
export async function resampleAudioBuffer(
  buffer: AudioBuffer,
  sampleRate: number,
): Promise<AudioBuffer> {
  if (buffer.sampleRate === sampleRate) return buffer;

  const ctx = new OfflineAudioContext({
    numberOfChannels: buffer.numberOfChannels,
    length: Math.max(1, Math.round((buffer.length * sampleRate) / buffer.sampleRate)),
    sampleRate,
  });
  const source = new AudioBufferSourceNode(ctx, { buffer });
  source.connect(ctx.destination);
  source.start();
  return ctx.startRendering();
}
