// createSampleVoicePool.ts
import { SampleVoicePool } from './SampleVoicePool';

export async function createSampleVoicePool(
  context: AudioContext,
  polyphony: number
): Promise<SampleVoicePool> {
  const pool = new SampleVoicePool(context, polyphony);
  await pool.init();
  return pool;
}
