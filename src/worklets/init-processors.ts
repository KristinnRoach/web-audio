import processorCode from '../../dist/processors/processors.js?raw';

type InitResult = {
  success: boolean;
  loadedPath: string;
  timestamp: string;
  error?: string;
};

// Worklet scope is per-context, and addModule is async: a shared in-flight promise
// keeps concurrent calls from registering the same processor twice.
const initialized = new WeakMap<BaseAudioContext, Promise<InitResult>>();

export function initProcessors(context: BaseAudioContext): Promise<InitResult> {
  const existing = initialized.get(context);
  if (existing) return existing;

  const pending = load(context).catch((err) => {
    initialized.delete(context); // ponytail: let a later call retry
    throw err;
  });
  initialized.set(context, pending);
  return pending;
}

async function load(context: BaseAudioContext): Promise<InitResult> {
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
      error: 'AudioWorklet not supported on this browser',
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

  return {
    success: true,
    loadedPath: 'blob-url',
    timestamp: new Date().toISOString(),
  };
}
