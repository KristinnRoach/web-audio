// createSamplePlayer.ts

import { getAudioContext, ensureAudioCtx } from '@/context';
import { SamplePlayer } from './SamplePlayer';
import { assert } from '@/utils';

import { initProcessors } from '@/worklets';
import { initIdb } from '@/storage/idb';
import { fetchInitSampleAsAudioBuffer } from '@/storage/assets/asset-utils';

/**
 * Creates a new SamplePlayer instance
 *
 * @param buffer - Optional audio buffer to use (will use default if not provided)
 * @param polyphony - Number of voices for polyphony (default: 16)
 * @param context - Optional AudioContext (will use global context if not provided)
 * @returns A new SamplePlayer instance
 */
export async function createSamplePlayer(
  buffer?: AudioBuffer | ArrayBuffer,
  polyphony: number = 16,
  context: AudioContext = getAudioContext(),
): Promise<SamplePlayer> {
  await ensureAudioCtx();
  assert(context, 'Audio context is not available');

  const workletResult = await initProcessors(context); // Ensure worklets are registered

  if (!workletResult.success) {
    // AudioWorklet is not supported on this browser
    throw new Error(
      'AudioWorklet is required but not supported on this browser. ' +
        'Please use a modern desktop browser (Chrome, Firefox, Edge) or update your mobile browser.',
    );
  }

  // Get buffer - only initialize IndexedDB if no buffer is provided
  let audiobuffer: AudioBuffer;
  if (buffer instanceof AudioBuffer) {
    audiobuffer = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    try {
      audiobuffer = await context.decodeAudioData(buffer);
    } catch (error) {
      console.error(
        'Failed to decode sample audiodata when creating SamplePlayer:',
        error,
      );
      throw error;
    }
  } else {
    await initIdb(); // Only initialize IndexedDB when needed
    audiobuffer = await fetchInitSampleAsAudioBuffer();
  }

  const samplePlayer = new SamplePlayer(context, polyphony, audiobuffer);

  await samplePlayer.init();

  return samplePlayer;
}
