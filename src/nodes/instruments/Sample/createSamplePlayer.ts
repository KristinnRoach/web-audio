// createSamplePlayer.ts

import { initProcessors } from '@/worklets';
import { getGlobalAudioContext, logAudioContextStats } from '@/context';
import { SamplePlayer, type SamplePlayerOptions } from './SamplePlayer';

/**
 * Creates a new SamplePlayer instance
 *
 * @param options - Optional player configuration; `sample` is loaded on init
 * @returns A new SamplePlayer instance
 */
export async function createSamplePlayer(
  options: Partial<SamplePlayerOptions> = {},
): Promise<SamplePlayer> {
  console.info('Creating SamplePlayer...');
  const context = options.context ?? getGlobalAudioContext();
  logAudioContextStats(context);

  const workletResult = await initProcessors(context); // Ensure worklets are registered

  if (!workletResult.success) {
    // AudioWorklet is not supported on this browser
    throw new Error(
      'AudioWorklet is required but not supported on this browser. ' +
        'Please use a modern desktop browser (Chrome, Firefox, Edge) or update your mobile browser.',
    );
  }

  const samplePlayer = new SamplePlayer({ ...options, context });

  await samplePlayer.init();

  return samplePlayer;
}
