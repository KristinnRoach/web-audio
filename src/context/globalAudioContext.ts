// globalAudioContext.ts

import { DEFAULT } from '@/constants';
import { assert, tryCatch } from '@/utils';

let globalAudioContext: AudioContext | null = null;
let resumePromise: Promise<void> | null = null;

export type AudioContextConfig = {
  sampleRate?: number;
  latencyHint?: AudioContextLatencyCategory;
};

// Non-async for use in constructors and synchronous code - Use ensureAudioCtx when possible
export function getAudioContext(config?: AudioContextConfig): AudioContext {
  if (!globalAudioContext) {
    globalAudioContext = new AudioContext({
      sampleRate: config?.sampleRate || DEFAULT.audioConfig.sampleRate,
      latencyHint: config?.latencyHint || 'interactive',
    });

    // Set up auto-resume on first creation, but don't await it
    if (globalAudioContext.state === 'suspended') {
      resumePromise = resumePromise || setupAutoResume();
    }
  }

  // Always return the context immediately, even if suspended
  return globalAudioContext;
}
export async function ensureAudioCtx(
  config?: AudioContextConfig
): Promise<AudioContext> {
  const context = getAudioContext(config);

  if (context.state === 'running') {
    return context;
  }
  if (context.state === 'closed') {
    globalAudioContext = null;
    const ctxResult = await tryCatch(() => ensureAudioCtx(config)); // creates a fresh context
    assert(
      ctxResult.data instanceof AudioContext && !ctxResult.error,
      'failed to re-created closed audio context',
      ctxResult.error
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

        resumeEvents.forEach((event) =>
          document.removeEventListener(event, handler)
        );
        resolve();
      }
    };

    resumeEvents.forEach((event) =>
      document.addEventListener(event, handler, { once: true })
    );
  });
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
  return (
    typeof AudioContext !== 'undefined' &&
    'setSinkId' in AudioContext.prototype
  );
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

/** Routes the global AudioContext (all audiolib output) to the given output device.
 *  Pass '' or 'default' to restore the system default output. */
export async function setAudioOutputDevice(deviceId: string): Promise<void> {
  assert(
    canSetOutputDevice(),
    'AudioContext.setSinkId is not supported in this browser'
  );
  const ctx = (await ensureAudioCtx()) as SinkCapableContext;
  await ctx.setSinkId(deviceId === 'default' ? '' : deviceId);
}

export function getCurrentOutputDeviceId(): string {
  const ctx = getAudioContext() as Partial<SinkCapableContext>;
  const { sinkId } = ctx;
  if (typeof sinkId === 'string') {
    return sinkId;
  }
  if (sinkId?.type === 'none') {
    return '';
  }
  return '';
}

export async function decodeAudioData(
  arrayBuffer: ArrayBuffer,
  config?: AudioContextConfig
): Promise<AudioBuffer | null> {
  const audioCtx = await ensureAudioCtx(config);
  return audioCtx.decodeAudioData(arrayBuffer);
}

export function releaseGlobalAudioContext(): void {
  if (globalAudioContext) {
    globalAudioContext
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
