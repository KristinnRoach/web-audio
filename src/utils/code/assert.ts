export function assert<T>(
  condition: any,
  message?: string,
  context?: T
): asserts condition {
  if (!condition) {
    const contextStr = context ? `\nContext: ${JSON.stringify(context)}` : '';
    throw new Error(
      `Assertion failed${message ? `: ${message}` : ''}${contextStr}`
    );
  }
}

/**
 * Example of proper assert usage with error handling:
 *
 * Using audiolib's tryCatch util:
 *
 * import { assert, tryCatch } from '@/utils';
 *
 * async function loadAndPlaySample(url: string) {
 *   const result = await tryCatch(() => fetchSample(url), "Failed to fetch sample");
 *   // Check if we got an error or a valid result
 *   assert(!result.error, "Sample fetch failed", { url });
 *
 *   // At this point, TypeScript knows result.error is false
 *   // and result.result contains our sample
 *   return playSample(result.data);
 * }
 *
 *
 * import { assert } from '@/utils';
 *
 * Using try-catch block:
 *
 * function playSample(audioBuffer: AudioBuffer | null) {
 *   try {
 *     // Assert that the buffer exists before trying to use it
 *     assert(audioBuffer !== null, "Audio buffer cannot be null", { function: "playSample" });
 *
 *     // If the assertion passes, we can safely use audioBuffer
 *     const source = audioContext.createBufferSource();
 *     source.buffer = audioBuffer;
 *     source.connect(audioContext.destination);
 *     source.start();
 *
 *     return true;
 *   } catch (error) {
 *     // Handle the assertion error
 *     console.error("Failed to play sample:", error.message);
 *
 *     // Optionally report the error or take recovery actions
 *     reportError(error);
 *
 *     return false;
 *   }
 * }
 *
 */
