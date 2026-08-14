// src/idb/audioStorage.ts
import { idb } from './idb';
import { DEFAULT } from '@/constants';
import {
  releaseOfflineContext,
  getOfflineAudioContext,
  OfflineContextConfig,
} from '@/context';

import { AppSample, IdbSample, SampleMetadata } from '@/types/Sample';

/**
 * Stores an AudioBuffer in IndexedDB
 *
 * @param id - Unique identifier for the sample
 * @param url - Original URL or path where the sample was loaded from
 * @param buffer - The decoded AudioBuffer to store
 * @returns Promise resolving to the stored item's ID
 */
export async function storeAudioSample(
  id: string, // Todo: id system!
  url: string,
  buffer: AudioBuffer, // todo: support these -> | ArrayBuffer,  | Float32Array,
  isDefaultInitSample: 0 | 1 = 0,
  isFromDefaultLib: 0 | 1 = 0
): Promise<string> {
  try {
    // Check if the sample already exists
    const exists = await idb.samples.get(id);
    if (exists) {
      console.warn(`Sample with ID ${id} already exists. Cancelled.`);
      return id;
    }

    // Extract raw audio data
    const numberOfChannels = buffer.numberOfChannels;
    const length = buffer.length;

    // Create a Float32Array with enough space for all channels
    const audioData = new Float32Array(numberOfChannels * length);

    // Copy each channel's data into our array
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      audioData.set(channelData, channel * length);
    }

    // Convert Float32Array to ArrayBuffer for storage
    const serializedData = audioData.buffer;

    // Create metadata
    const metadata = {
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: numberOfChannels,
    };

    // Create the sample item
    const sampleItem: IdbSample = {
      id,
      url,
      audioData: serializedData,
      dateAdded: new Date(),
      metadata,
      isDefaultInitSample,
      isFromDefaultLib,
    };

    // Store it in IndexedDB
    await idb.samples.put(sampleItem);

    return id;
  } catch (error) {
    console.error('Failed to store audio sample:', error);
    throw new Error(
      `Failed to store audio sample: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function getSampleItem(
  id: string
): Promise<IdbSample | undefined> {
  return await idb.samples.get(id);
}

export async function getSampleMetadata(
  id: string
): Promise<IdbSample['metadata'] | undefined> {
  const item = await idb.samples.get(id);
  return item?.metadata || undefined;
}

export async function getSampleArrayBuffer(
  id: string
): Promise<ArrayBuffer | undefined> {
  const item = await idb.samples.get(id);
  return item?.audioData;
}

export async function getSampleAsFloat32Array(
  id: string
): Promise<Float32Array | undefined> {
  const item = await idb.samples.get(id);
  return item ? new Float32Array(item.audioData) : undefined;
}

export async function getSamplesDateAdded(
  id: string
): Promise<Date | undefined> {
  const item = await idb.samples.get(id);
  return item?.dateAdded;
}

// todo: getByUrl? sort/get by duration / samplerate / channels etc.

function extractContextConfig(
  metadata: SampleMetadata,
  audioData: Float32Array
): OfflineContextConfig {
  // Data needed for reconstruction of AudioBuffer
  const channels = metadata?.channels || 1; // make required when storing?
  const length = audioData.byteLength / (4 * channels); // 4 bytes per float
  const sampleRate = metadata?.sampleRate || DEFAULT.audioConfig.sampleRate;
  return {
    length,
    numberOfChannels: channels,
    sampleRate,
  };
}

/**
 * Retrieves an AudioBuffer from IndexedDB
 *
 * @param id - Unique identifier for the sample
 * @returns Promise resolving to the AudioBuffer or undefined if not found
 */
export async function getSampleAudioBuffer(
  id: string,
  sampleItem?: IdbSample
): Promise<AudioBuffer | undefined> {
  try {
    const item = sampleItem ? sampleItem : await idb.samples.get(id);

    if (!item) return undefined;

    // Convert ArrayBuffer back to Float32Array
    const audioData = new Float32Array(item.audioData);

    // Metadata needed for reconstruction
    const config: OfflineContextConfig = extractContextConfig(
      item.metadata,
      audioData
    );

    const context = getOfflineAudioContext(config);

    // Create a new AudioBuffer
    const audioBuffer = context.createBuffer(
      config.numberOfChannels!,
      config.length,
      config.sampleRate!
    );

    // Copy data into the AudioBuffer for each channel
    for (let channel = 0; channel < config.numberOfChannels!; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      const start = channel * length;
      const end = start + length;
      channelData.set(audioData.subarray(start, end));
    }

    // Always release the OfflineAudioContext after use!
    releaseOfflineContext(config);

    return audioBuffer;
  } catch (error) {
    console.error('Failed to retrieve audio sample:', error);
    throw new Error(
      `Failed to retrieve audio sample: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function getAppSample(
  id: string,
  audioDataType: 'AudioBuffer' | 'Float32Array' | 'ArrayBuffer' = 'AudioBuffer',
  getMetadata = true,
  getInfo = true,
  idbSample: IdbSample | null = null
): Promise<
  | {
      audioData: AudioBuffer | Float32Array | ArrayBuffer;
      sampleId: string;
      sampleInfo?: Partial<AppSample>;
    }
  | undefined
> {
  const item = idbSample || (await getSampleItem(id));

  if (!item) return undefined;
  if (idbSample && item.id !== idbSample.id) {
    console.warn('sample id and idb item do not match, check logic');
    return undefined;
  }

  let audioData: AudioBuffer | Float32Array | ArrayBuffer;

  switch (audioDataType) {
    case 'AudioBuffer':
      audioData = (await getSampleAudioBuffer(item.id, item)) as AudioBuffer;
      break;
    case 'Float32Array':
      audioData = new Float32Array(item.audioData);
      break;
    case 'ArrayBuffer':
      audioData = item.audioData;
      break;
  }

  if (!audioData) {
    console.error(`
      Failed to get audio data from IDb 
      for sampleId: ${item.id}`);
    return undefined;
  }

  const sampleInfo: Partial<AppSample> = {};

  if (getInfo) {
    sampleInfo.url = item.url;
    sampleInfo.dateAdded = item.dateAdded;
    sampleInfo.extraInfo = {}; // replace if needed
  }

  if (getMetadata) {
    sampleInfo.metadata = item.metadata;
  }

  return {
    audioData,
    sampleId: item.id,
    sampleInfo: getInfo ? sampleInfo : undefined,
  };
}

/**
 * Retrieves all audio samples from IndexedDB
 *
 * @returns Promise resolving to an array of sample items
 */
export async function getAllAudioSamples(): Promise<IdbSample[]> {
  try {
    const allSamples = await idb.samples.toArray();
    return allSamples;
  } catch (error) {
    console.error('Failed to retrieve all audio samples:', error);
    throw new Error(
      `Failed to retrieve all audio samples: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Get most recently added sample item, as stored in IndexedDB
async function getLatestSampleItem(): Promise<IdbSample | undefined> {
  return (
    (await idb.samples.orderBy('dateAdded').reverse().first()) || undefined
  );
}
// export async function getAudioSampleByUrl(url: string): Promise<ISampleItem | undefined> {

export async function getLatestSample(): Promise<
  | {
      audioData: AudioBuffer | Float32Array | ArrayBuffer;
      sampleId: string;
      sampleInfo?: Partial<AppSample>;
    }
  | undefined
> {
  try {
    const item = await getLatestSampleItem();
    if (!item) {
      console.warn('getLatestSampleItem returned undefined');
      return undefined;
    }
    // Check if the sample exists
    const exists = await idb.samples.get(item.id);
    if (!exists) {
      console.warn(`Sample with ID ${item.id} does not exist.`);
      return undefined;
    }

    return await getAppSample(item.id);
  } catch (error) {
    console.error('Failed to retrieve latest audio sample:', error);
    throw new Error(
      `Failed to retrieve sample: 
      ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Removes an audio sample from IndexedDB
 *
 * @param id - Unique identifier for the sample
 * @returns Promise resolving to true if sample was deleted, false otherwise
 */
export async function removeAudioSample(id: string): Promise<boolean> {
  try {
    // Check if the sample exists
    const exists = await idb.samples.get(id);
    if (!exists) {
      return false;
    }

    // Delete the sample
    await idb.samples.delete(id);
    return true;
  } catch (error) {
    console.error('Failed to remove audio sample:', error);
    throw new Error(
      `Failed to remove audio sample: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Checks if an audio sample exists in IndexedDB
 *
 * @param id - Unique identifier for the sample
 * @returns Promise resolving to true if sample exists, false otherwise
 */
export async function hasAudioSample(id: string): Promise<boolean> {
  try {
    const count = await idb.samples.where('id').equals(id).count();
    return count > 0;
  } catch (error) {
    console.error('Failed to check for audio sample:', error);
    throw new Error(
      `Failed to check for audio sample: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// todo: fix getInitSample

// export async function storeAsInitSample( // this works
//   id: string,
//   url: string,
//   audioBuffer: AudioBuffer
// ): Promise<string> {
//   id = 'default-' + id; // todo: id system!
//   const returnedId = await storeAudioSample(id, url, audioBuffer, 1, 1);
//   console.log('Stored default sample with ID:', returnedId);
//   return returnedId;
// }

// export async function getInitSample(): Promise<{} | undefined> {   // type
//   const item = await getInitSampleItem();
//   if (!item) {
//     console.error(`Failed to fetch init sample from Idb. Item is: ${item}`);
//     return undefined;
//   }

//   return await getAppSample(item.id); // using default params
// }

// async function getInitSampleItem(): Promise<IdbSample | undefined> {
//   try {
//     const defaultSampleItem = await idb.samples
//       .where('isDefaultInitSample')
//       .equals(1)
//       .first();
//     return defaultSampleItem || undefined;
//   } catch (error) {
//     console.error('Failed to retrieve default init sample:', error);
//     throw new Error(
//       `Failed to retrieve default init sample: ${error instanceof Error ? error.message : String(error)}`
//     );
//   }
// }
