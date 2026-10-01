// globalAudioContext.ts

import { DEFAULT } from '@/constants';
import { assert } from '@/utils';

let globalAudioContext: AudioContext | null = null;
let autoResumeArmed = false;
// Always the options the live global context was created with: any change replaces it
let globalOptions: AudioContextOptions = {
  sampleRate: DEFAULT.audioConfig.sampleRate,
  latencyHint: 'interactive',
};

/** Sets the options the global AudioContext is created with. Can be called any time;
 *  options merge into the current ones. If the global context exists and an option
 *  changes, it is closed and replaced (AudioContext options are fixed at construction).
 *  Nodes built on the old context are dead, so rebuild them on the returned one.
 *  Returns the live global context, or null if none exists yet (created lazily). */
export function configureGlobalAudioContext(options: AudioContextOptions): AudioContext | null {
  const prev = globalOptions;
  globalOptions = { ...prev, ...options };

  const ctx = globalAudioContext;
  if (!ctx || ctx.state === 'closed') return null;

  const unchanged = (Object.keys(options) as (keyof AudioContextOptions)[]).every(
    (key) => options[key] === prev[key],
  );
  if (unchanged) return ctx;

  const sinkId = getCurrentOutputDeviceId(ctx);
  releaseGlobalAudioContext();
  const next = getOrCreateGlobalAudioContext();
  // Keep the output device picked with setAudioOutputDevice
  if (sinkId) {
    setAudioOutputDevice(sinkId, next).catch((err) => {
      console.warn('[GlobalAudioContext] could not restore output device', err);
    });
  }
  return next;
}

/** Returns the library global singleton, creating it (or replacing a closed one) with
 *  the configured options. Synchronous: it may be suspended until the first user
 *  gesture, which resumes it automatically. */
export function getOrCreateGlobalAudioContext(): AudioContext {
  if (!globalAudioContext || globalAudioContext.state === 'closed') {
    globalAudioContext = new AudioContext(globalOptions);
  }
  if (globalAudioContext.state === 'suspended') armAutoResume();
  return globalAudioContext;
}

/** Resumes the global context on the next user gesture. Re-armed whenever
 *  getOrCreateGlobalAudioContext finds it suspended again. */
function armAutoResume(): void {
  /* istanbul ignore next – browser-only safeguard */
  if (autoResumeArmed || typeof document === 'undefined') return;
  autoResumeArmed = true;
  const resumeEvents = ['click', 'touchstart', 'keydown'];

  const handler = () => {
    resumeEvents.forEach((event) => document.removeEventListener(event, handler));
    autoResumeArmed = false;
    // Called synchronously inside the gesture, which iOS Safari requires
    void globalAudioContext?.resume();
  };

  resumeEvents.forEach((event) => document.addEventListener(event, handler));
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
  const ctx = (context ?? getOrCreateGlobalAudioContext()) as SinkCapableContext;
  await ctx.setSinkId(deviceId === 'default' ? '' : deviceId);
}

/** Output device id of `context` (default: the global AudioContext). '' means system default. */
export function getCurrentOutputDeviceId(context?: AudioContext): string {
  const { sinkId } = (context ?? getOrCreateGlobalAudioContext()) as Partial<SinkCapableContext>;
  // AudioSinkInfo ({ type: 'none' }) is silent output, not a device
  return typeof sinkId === 'string' ? sinkId : '';
}

/** Clears the global singleton and starts closing it. The next
 *  getOrCreateGlobalAudioContext call creates a fresh one. */
export function releaseGlobalAudioContext(): void {
  const ctx = globalAudioContext;
  if (!ctx) return;
  // Clear first: clearing after close() settles would wipe out a context created meanwhile
  globalAudioContext = null;
  void ctx.close().catch((err) => {
    console.warn('[GlobalAudioContext] close() failed', err);
  });
}
