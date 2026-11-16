import { SampleVoice, createSampleWorklet, type SampleVoiceChainNode } from './SampleVoice';

/** One processor renders every voice; each `SampleVoice` wraps one of its outputs. */
export async function createSampleVoices(
  numVoices: number,
  context: BaseAudioContext,
  options?: { internalSignalChain?: readonly SampleVoiceChainNode[] },
): Promise<SampleVoice[]> {
  const worklet = createSampleWorklet(context, numVoices);
  const voices = Array.from(
    { length: numVoices },
    (_, voiceIndex) => new SampleVoice(context, { ...options, worklet, voiceIndex }),
  );
  // A report names its voice; `initialized` names none and goes to all.
  worklet.port.onmessage = ({ data }) => {
    for (const voice of data.voice === undefined ? voices : [voices[data.voice]]) {
      voice.receive(data);
    }
  };
  try {
    await Promise.all(voices.map((voice) => voice.init()));
  } catch (error) {
    voices.forEach((voice) => voice.dispose());
    throw error;
  }
  return voices;
}
