/**
 * Read frames [start, end) into an owned array: Brave can alter the live
 * channel on getChannelData(). copyFromChannel() may alter the copy, but leaves
 * the source buffer intact.
 */
export function copyChannelData(
  buffer: AudioBuffer,
  channel: number,
  start = 0,
  end = buffer.length,
): Float32Array<ArrayBuffer> {
  const data = new Float32Array(Math.max(0, Math.min(end, buffer.length) - start));
  buffer.copyFromChannel(data, channel, start);
  return data;
}
