// offlineAudioContext.ts

const offlineInstances = new Map<string, OfflineAudioContext>();

const OFFLINE_DEFAULTS = {
  sampleRate: 44100,
  numberOfChannels: 2,
} as const;

export type OfflineContextConfig = {
  length: number;
  numberOfChannels?: number;
  sampleRate?: number;
};

function generateContextKey(config: OfflineContextConfig): string {
  return `${config.length}-${config.numberOfChannels || OFFLINE_DEFAULTS.numberOfChannels}-${config.sampleRate || OFFLINE_DEFAULTS.sampleRate}`;
}

export function getOfflineAudioContext(config: OfflineContextConfig): OfflineAudioContext {
  if (!config.length || config.length <= 0) {
    throw new Error(
      'Length is required, e.g. buffer size (samples), or (duration (seconds) * sample rate)',
      { cause: config },
    );
  }

  const key = generateContextKey(config);
  let context = offlineInstances.get(key);

  if (context) {
    return context;
  }

  const newContext = new OfflineAudioContext({
    length: config.length,
    numberOfChannels: config.numberOfChannels || OFFLINE_DEFAULTS.numberOfChannels,
    sampleRate: config.sampleRate || OFFLINE_DEFAULTS.sampleRate,
  });
  offlineInstances.set(key, newContext);

  return newContext;
}

export function releaseOfflineContext(config: OfflineContextConfig): void {
  const key = generateContextKey(config);
  offlineInstances.delete(key);
}

// Add this new function for testing purposes
export function clearAllOfflineContexts(): void {
  offlineInstances.clear();
}
