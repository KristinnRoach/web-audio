// createSamplePlayer.ts

import { initProcessors } from '@/worklets';
import { getOrCreateGlobalAudioContext, logAudioContextStats } from '@/context';
import { SamplePlayer, type SamplePlayerOptions } from './SamplePlayer';

/**
 * Creates a new SamplePlayer instance
 *
 * @param buffer - Audio buffer data to use for the player
 * @param options - Optional player configuration
 * @returns A new SamplePlayer instance
 */
export async function createSamplePlayer(
  buffer: AudioBuffer | ArrayBuffer,
  options: Partial<SamplePlayerOptions> = {},
): Promise<SamplePlayer> {
  console.info('Creating SamplePlayer...');
  if (!options.context) {
    console.info('No AudioContext provided in options; using Audiolib global AudioContext');
  }
  const context = options.context ?? getOrCreateGlobalAudioContext();
  logAudioContextStats(context);

  const workletResult = await initProcessors(context); // Ensure worklets are registered

  if (!workletResult.success) {
    // AudioWorklet is not supported on this browser
    throw new Error(
      'AudioWorklet is required but not supported on this browser. ' +
        'Please use a modern desktop browser (Chrome, Firefox, Edge) or update your mobile browser.',
    );
  }

  let audioBuffer: AudioBuffer;
  if (buffer instanceof AudioBuffer) {
    audioBuffer = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    try {
      audioBuffer = await context.decodeAudioData(buffer);
    } catch (error) {
      console.error('Failed to decode sample audiodata when creating SamplePlayer:', error);
      throw error;
    }
  } else {
    throw new Error(
      'createSamplePlayer requires an AudioBuffer or ArrayBuffer. No default sample is bundled.',
    );
  }

  const samplePlayer = new SamplePlayer({ ...options, context, audioBuffer });

  await samplePlayer.init();

  return samplePlayer;
}
