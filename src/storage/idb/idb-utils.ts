import { idb } from './idb';
import { fetchInitSampleAsAudioBuffer } from '../assets/asset-utils';
import * as sampleLib from './audioStorage';

const ASSETS_PATH = '../assets/';
const INIT_SAMPLE_FILE = `init_sample.wav`;

export async function initIdb() {
  try {
    await idb.open();
    await ensureInitSample();
  } catch (error) {
    console.error('Error opening IndexedDB:', error);
  }
}

// ensure init sample is in idb
export async function ensureInitSample(): Promise<void> {
  try {
    const sampleId = 'default-init-sample';
    const sampleUrl = `${ASSETS_PATH}${INIT_SAMPLE_FILE}`;

    // Check if the init sample already exists in IndexedDB
    const existingSample = await idb.samples.get(sampleId);
    if (existingSample) return;

    console.info(`Init sample not in idb, fetching from source url..`);
    // Fetch and decode the init sample
    const audioBuffer = await fetchInitSampleAsAudioBuffer();

    if (!audioBuffer || audioBuffer.length <= 0) {
      console.warn('Failed to decode init sample');
      return;
    }

    // Store the decoded AudioBuffer in IndexedDB
    const storedID = await sampleLib.storeAudioSample(
      sampleId,
      sampleUrl,
      audioBuffer,
      1, // is default init
      1 // is from audiolib's samplelib
    );

    console.info(`Storing init sample in idb, stored sample ID: ${storedID}`);
  } catch (error) {
    console.warn('Error ensuring init sample in IndexedDB:', error);
  }
}

export async function closeIdb() {
  try {
    idb.close();
    console.log('IndexedDB closed successfully');
  } catch (error) {
    console.error('Error closing IndexedDB:', error);
  }
}
export async function deleteIdb() {
  try {
    await idb.delete();
    console.log('IndexedDB deleted successfully');
  } catch (error) {
    console.error('Error deleting IndexedDB:', error);
  }
}

export async function clearIdb() {
  try {
    await idb.samples.clear();
    console.log('IndexedDB cleared successfully');
  } catch (error) {
    console.error('Error clearing IndexedDB:', error);
  }
}
