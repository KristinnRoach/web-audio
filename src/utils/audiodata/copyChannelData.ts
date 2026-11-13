/**
 * Read into an owned array: Brave can alter the live channel on getChannelData().
 * copyFromChannel() may alter the copy, but leaves the source buffer intact.
 */
export function copyChannelData(buffer: AudioBuffer, channel: number): Float32Array<ArrayBuffer> {
  const data = new Float32Array(buffer.length);
  buffer.copyFromChannel(data, channel);
  return data;
}
