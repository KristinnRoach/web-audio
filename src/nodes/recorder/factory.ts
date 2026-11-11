import { Recorder } from './Recorder';
import { getGlobalAudioContext } from '@/context';

/**
 * Creates a new audio recorder
 *
 * @param context - Optional AudioContext to use. If not provided, the global audio context will be used.
 * @returns A new Recorder instance
 */
function createAudioRecorder(context?: AudioContext): Recorder {
  const audioContext = context || getGlobalAudioContext();
  return new Recorder(audioContext);
}

export { createAudioRecorder, Recorder };
