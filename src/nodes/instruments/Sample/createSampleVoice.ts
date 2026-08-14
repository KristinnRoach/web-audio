// createSampleVoice.ts
import { SampleVoice } from './SampleVoice';

export async function createSampleVoice(
  context: AudioContext,
  options?: { processorOptions?: any; enableFilters?: boolean }
): Promise<SampleVoice> {
  const voice = new SampleVoice(context, options);
  await voice.init();
  return voice;
}

export async function createSampleVoices(
  numVoices: number,
  context: AudioContext,
  options?: { processorOptions?: any; enableFilters?: boolean }
): Promise<SampleVoice[]> {
  const voicePromises = Array.from({ length: numVoices }, () =>
    createSampleVoice(context, options)
  );
  return Promise.all(voicePromises);
}
