// globalAudioContext.ts

import { DEFAULT } from '@/constants';
import { assert, tryCatch } from '@/utils';

let globalAudioContext: AudioContext | null = null;
let resumePromise: Promise<void> | null = null;
let globalConfig: AudioContextConfig = {};

export type AudioContextConfig = {
  sampleRate?: number;
  latencyHint?: AudioContextLatencyCategory;
};

/** Sets the config the global AudioContext is created with. Call it before anything
 *  touches audio: the context is created once, so later calls cannot change it.
 *  Throws if the context already exists at a different sample rate. */
export function configureGlobalAudioContext(config: AudioContextConfig): void {
  if (globalAudioContext) {
    assert(
      !config.sampleRate || globalAudioContext.sampleRate === config.sampleRate,
      `global AudioContext already created at ${globalAudioContext.sampleRate} Hz, cannot configure ${config.sampleRate} Hz`,
    );
    return;
  }
  globalConfig = config;
}

/** Returns the library global singleton, creating it if needed.
 * Synchronous: it may still be suspended. Config applies only on creation. */
export function getGlobalAudioContext(config?: AudioContextConfig): AudioContext {
  if (!globalAudioContext) {
    globalAudioContext = new AudioContext({
      sampleRate: config?.sampleRate || globalConfig.sampleRate || DEFAULT.audioConfig.sampleRate,
      latencyHint: config?.latencyHint || globalConfig.latencyHint || 'interactive',
    });

    // Set up auto-resume on first creation, but don't await it
    if (globalAudioContext.state === 'suspended') {
      resumePromise = resumePromise || setupAutoResume();
    }
  }

  // Always return the context immediately, even if suspended
  return globalAudioContext;
}
/** Returns the global singleton after the existing auto-resume flow completes.
 * Recreates a closed singleton. Config applies only on creation. */
export async function ensureGlobalAudioContext(config?: AudioContextConfig): Promise<AudioContext> {
  const context = getGlobalAudioContext(config);

  if (context.state === 'running') {
    return context;
  }
  if (context.state === 'closed') {
    globalAudioContext = null;
    const ctxResult = await tryCatch(() => ensureGlobalAudioContext(config)); // creates a fresh context
    assert(
      ctxResult.data instanceof AudioContext && !ctxResult.error,
      'failed to re-created closed audio context',
      ctxResult.error,
    );
    return ctxResult.data;
  }
  // If resumePromise is null, set it up
  resumePromise = resumePromise || setupAutoResume();
  await resumePromise;

  return context;
}

function setupAutoResume(): Promise<void> {
  /* istanbul ignore next – browser-only safeguard */
  if (typeof document === 'undefined') {
    return Promise.resolve();
  }
  const resumeEvents = ['click', 'touchstart', 'keydown'];

  return new Promise((resolve) => {
    const handler = async () => {
      if (globalAudioContext) {
        await globalAudioContext.resume();

        resumeEvents.forEach((event) => document.removeEventListener(event, handler));
        resolve();
      }
    };

    resumeEvents.forEach((event) => document.addEventListener(event, handler, { once: true }));
  });
}

/** Whether context is the current library global singleton. Does not create one. */
export function isGlobalAudioContext(context: AudioContext): boolean {
  return context === globalAudioContext;
}

export function logAudioContextStats(context: AudioContext): void {
  console.info(`AudioContext stats:`);
  console.info(`  Using Global context: ${isGlobalAudioContext(context)}`);
  console.info(`  State: ${context.state}`);
  console.info(`  Sample Rate: ${context.sampleRate}`);
  console.info(`  Base Latency: ${context.baseLatency}`);
  console.info(`  Output Latency: ${context.outputLatency}`);
}

// --- Output device selection ---

type SinkCapableContext = AudioContext & {
  setSinkId(id: AudioContextSinkId): Promise<void>;
  sinkId: AudioContextSinkId;
};

type AudioSinkInfo = {
  readonly type: 'none';
};

type AudioContextSinkId = string | AudioSinkInfo;

/** False in Safari — AudioContext.setSinkId is Chromium/Firefox only */
export function canSetOutputDevice(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

/** Device labels are only populated once mic permission has been granted */
export async function getAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audiooutput');
}

/** Device labels are only populated once mic permission has been granted */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/** Routes `context` (default: the global AudioContext) to the given output device.
 *  Pass '' or 'default' to restore the system default output. */
export async function setAudioOutputDevice(
  deviceId: string,
  context?: AudioContext,
): Promise<void> {
  assert(canSetOutputDevice(), 'AudioContext.setSinkId is not supported in this browser');
  const ctx = (context ?? (await ensureGlobalAudioContext())) as SinkCapableContext;
  await ctx.setSinkId(deviceId === 'default' ? '' : deviceId);
}

/** Output device id of `context` (default: the global AudioContext). '' means system default. */
export function getCurrentOutputDeviceId(context?: AudioContext): string {
  const { sinkId } = (context ?? getGlobalAudioContext()) as Partial<SinkCapableContext>;
  // AudioSinkInfo ({ type: 'none' }) is silent output, not a device
  return typeof sinkId === 'string' ? sinkId : '';
}

/** Decodes audio using the global singleton and its existing auto-resume flow. */
export async function decodeGlobalAudioData(
  arrayBuffer: ArrayBuffer,
  config?: AudioContextConfig,
): Promise<AudioBuffer | null> {
  const audioCtx = await ensureGlobalAudioContext(config);
  return audioCtx.decodeAudioData(arrayBuffer);
}

/** Starts closing the global singleton and clears it after close settles. */
export function releaseGlobalAudioContext(): void {
  if (globalAudioContext) {
    void globalAudioContext
      .close()
      .catch((err) => {
        console.warn('[GlobalAudioContext] close() failed', err);
      })
      .then(() => {
        globalAudioContext = null;
        resumePromise = null;
      });
  }
}
