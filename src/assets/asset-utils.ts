import initSampleUrl from './init_sample.webm?url';
import { DEFAULT } from '@/constants';

export async function fetchInitSample() {
  const response = await fetch(initSampleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch init sample: ${response.statusText}`);
  }
  return await response.arrayBuffer();
}

export async function fetchInitSampleAsBlob() {
  const response = await fetch(initSampleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch init sample: ${response.statusText}`);
  }
  return await response.blob();
}

export async function fetchInitSampleAsAudioBuffer() {
  const response = await fetch(initSampleUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch init sample: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const audioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({
    sampleRate: DEFAULT.audioConfig.sampleRate,
  });

  try {
    return await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    await audioContext.close();
  }
}
