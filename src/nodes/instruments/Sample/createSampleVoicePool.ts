// createSampleVoicePool.ts
import { SampleVoicePool } from "./SampleVoicePool";
import type { SampleVoiceChainNode } from "./SampleVoice";

export async function createSampleVoicePool(
  context: AudioContext,
  polyphony: number,
  voiceSignalChain?: readonly SampleVoiceChainNode[],
): Promise<SampleVoicePool> {
  const pool = new SampleVoicePool(context, polyphony, voiceSignalChain);
  await pool.init();
  return pool;
}
