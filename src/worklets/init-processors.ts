import processorCode from '../../dist/processors/processors.js?raw';

let processorsInitialized = false;

// Function to try multiple paths to load the audio worklet
export async function initProcessors(context: AudioContext) {
  if (processorsInitialized) {
    console.info('AudioWorklet processors already initialized, skipping');
    return {
      success: true,
      loadedPath: 'already-initialized',
      timestamp: new Date().toISOString(),
    };
  }

  // Check if AudioWorklet is supported
  if (!context.audioWorklet) {
    // This is a known issue on some Android browsers where AudioWorkletNode exists
    // but context.audioWorklet is not available
    console.warn('AudioWorklet API is not fully supported on this browser.');
    console.warn('The audio sampler requires AudioWorklet support. Please try:');
    console.warn('1. Using Chrome, Firefox, or Edge on desktop');
    console.warn('2. Updating your mobile browser to the latest version');
    console.warn('3. Using a different browser on mobile (Chrome or Firefox)');
    
    // Return a "failed" status instead of throwing
    return {
      success: false,
      loadedPath: 'none-worklet-not-supported',
      timestamp: new Date().toISOString(),
      error: 'AudioWorklet not supported on this browser'
    };
  }

  const processorUrl = URL.createObjectURL(
    new Blob([processorCode], { type: 'application/javascript' }),
  );

  try {
    await context.audioWorklet.addModule(processorUrl);
  } finally {
    URL.revokeObjectURL(processorUrl);
  }

  processorsInitialized = true;
  console.info('Audiolib: AudioWorklet module loaded.');

  return {
    success: true,
    loadedPath: 'blob-url',
    timestamp: new Date().toISOString(),
  };
}
