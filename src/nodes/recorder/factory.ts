import { Recorder } from './Recorder';
import { getOrCreateGlobalAudioContext } from '@/context';

/**
 * Creates and initializes a new audio recorder
 *
 * @param context - Optional AudioContext to use. If not provided, the global audio context will be used.
 * @returns A promise that resolves to the initialized Recorder instance // ! unnecessary async
 */
async function createAudioRecorder(context?: AudioContext): Promise<Recorder> {
  const audioContext = context || getOrCreateGlobalAudioContext();
  return new Recorder(audioContext);
}

export { createAudioRecorder, Recorder };
