// Todo: fix idb methods first
// // src/utils/loadAudio.ts

// import { getAudioContext } from '@/context/globalAudioContext';
// import {
//   storeAudioSample,
//   // getSampleAudioBuffer,
//   hasAudioSample,
// } from '@/store/persistent/idb/audioStorage';

// const DEFAULT_SAMPLE_URL = new URL(
//   '/audio-samples/trimmed.wav',
//   import.meta.url
// ).toString();

// /**
//  * Loads and decodes an audio sample from a URL or file path
//  * with IndexedDB caching support
//  *
//  * @param path - URL or path to the audio file
//  * @param idbOptions - Loading options
//  * @returns Promise resolving to the decoded AudioBuffer
//  * @throws Error if loading or decoding fails
//  */
// export async function loadAudioSample(
//   path: string,
//   idbOptions: {
//     storeSample?: boolean; // Whether to use IndexedDB cache
//     forceReload?: boolean; // Whether to force reload even if cached
//     sampleId?: string; // todo: sampleId system for manual retrieval (defaults to path for now)
//   } = { storeSample: true, forceReload: false }
// ): Promise<AudioBuffer> {
//   const { storeSample, forceReload, sampleId = path } = idbOptions;

//   try {
//     // Check cache first if enabled and not forcing reload
//     if (storeSample && !forceReload) {
//       const cached = await hasAudioSample(sampleId);

//       if (cached) {
//         console.log(`Loading audio sample from cache: ${sampleId}`);
//         const cachedBuffer = await getSampleAudioBuffer(sampleId);

//         if (cachedBuffer) {
//           return cachedBuffer;
//         }
//       }
//     }

//     const audioContext = getAudioContext();
//     const response = await fetch(path);

//     if (!response.ok) {
//       throw new Error(
//         `Failed to fetch audio file: ${response.status} ${response.statusText}`
//       );
//     }

//     const arrayBuffer = await response.arrayBuffer();
//     const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

//     if (storeSample) {
//       await storeAudioSample(sampleId, path, audioBuffer);
//     }

//     return audioBuffer;
//   } catch (error) {
//     console.error('Error loading audio sample:', error);
//     throw new Error(
//       `Failed to load audio sample from ${path}: ${error instanceof Error ? error.message : String(error)}`
//     );
//   }
// }
// // load default audio sample
// export async function loadDefaultSample(): Promise<AudioBuffer> {
//   return loadAudioSample(DEFAULT_SAMPLE_URL, {
//     storeSample: true,
//     forceReload: false,
//     sampleId: DEFAULT_SAMPLE_URL,
//   });
// }

// /**
//  * Loads multiple audio samples at once
//  *
//  * @param paths - Array of URLs or paths to audio files
//  * @param options - Loading options (same as loadAudioSample)
//  * @returns Promise resolving to a Map of paths to AudioBuffers
//  */
// export async function loadAudioSamples(
//   paths: string[],
//   options: Parameters<typeof loadAudioSample>[1] = {}
// ): Promise<Map<string, AudioBuffer>> {
//   const samples = new Map<string, AudioBuffer>();

//   await Promise.all(
//     paths.map(async (path) => {
//       try {
//         const buffer = await loadAudioSample(path, options);
//         samples.set(path, buffer);
//       } catch (error) {
//         console.warn(`Failed to load sample ${path}:`, error);
//       }
//     })
//   );

//   return samples;
// }

// // simpler version without IndexedDB caching below:

// // import { getAudioContext } from '../context/globalAudioContext';

// // /**
// //  * Loads and decodes an audio sample from a URL or file path
// //  *
// //  * @param path - URL or path to the audio file
// //  * @returns Promise resolving to the decoded AudioBuffer
// //  * @throws Error if loading or decoding fails
// //  */
// // export async function loadAudioSample(path: string): Promise<AudioBuffer> {
// //   try {
// //     // Get the audio context
// //     const audioContext = await getAudioContext();

// //     // Fetch the audio file
// //     const response = await fetch(path);

// //     // Check if the fetch was successful
// //     if (!response.ok) {
// //       throw new Error(
// //         `Failed to fetch audio file: ${response.status} ${response.statusText}`
// //       );
// //     }

// //     // Get the audio data as ArrayBuffer
// //     const arrayBuffer = await response.arrayBuffer();

// //     // Decode the audio data
// //     const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

// //     return audioBuffer;
// //   } catch (error) {
// //     console.error('Error loading audio sample:', error);
// //     throw new Error(
// //       `Failed to load audio sample from ${path}: ${error instanceof Error ? error.message : String(error)}`
// //     );
// //   }
// // }

// // /**
// //  * Loads multiple audio samples at once
// //  *
// //  * @param paths - Array of URLs or paths to audio files
// //  * @returns Promise resolving to a Map of paths to AudioBuffers
// //  */
// // export async function loadAudioSamples(
// //   paths: string[]
// // ): Promise<Map<string, AudioBuffer>> {
// //   const samples = new Map<string, AudioBuffer>();

// //   await Promise.all(
// //     paths.map(async (path) => {
// //       try {
// //         const buffer = await loadAudioSample(path);
// //         samples.set(path, buffer);
// //       } catch (error) {
// //         console.warn(`Failed to load sample ${path}:`, error);
// //       }
// //     })
// //   );

// //   return samples;
// // }
