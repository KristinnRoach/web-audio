// globalAudioContext.ts

import { DEFAULT } from '@/constants';
import { assert } from '@/utils';

const DEFAULT_OPTIONS: AudioContextOptions = {
  sampleRate: DEFAULT.audioConfig.sampleRate,
  latencyHint: 'interactive',
};

let globalAudioContext: AudioContext | null = null;
// Options of the latest configureAudio call, reused when a closed context is recreated
let globalOptions = DEFAULT_OPTIONS;
let autoResumeArmed = false;

/** Returns the library's global AudioContext, creating it (or replacing a closed one)
 *  on first use. Synchronous: it may be suspended until the first user gesture,
 *  which resumes it automatically. */
export function getGlobalAudioContext(): AudioContext {
  if (!globalAudioContext || globalAudioContext.state === 'closed') {
    globalAudioContext = new AudioContext(globalOptions);
  }
  if (globalAudioContext.state === 'suspended') armAutoResume();
  return globalAudioContext;
}

/** Sets the global AudioContext options; options not given use the library defaults.
 *  Before first use this only stores them. Afterwards, changed options replace the
 *  context and close the previous one, so every node built on it stops; rebuild them.
 *  Unchanged options are a no-op. */
export function configureAudio(options: AudioContextOptions): void {
  const next = { ...DEFAULT_OPTIONS, ...options };
  // ponytail: shallow compare, fine for flat AudioContextOptions
  const changed = (Object.keys(next) as (keyof AudioContextOptions)[]).some(
    (key) => next[key] !== globalOptions[key],
  );
  globalOptions = next;
  const previous = globalAudioContext;
  if (!changed || !previous) return;
  // Swap before closing, so the async close can't race with the new context
  globalAudioContext = null;
  getGlobalAudioContext();
  if (previous.state !== 'closed') {
    void previous.close().catch((err) => {
      console.warn('[GlobalAudioContext] close() failed', err);
    });
  }
}

/** Resumes the global context on the next user gesture. Re-armed whenever
 *  getGlobalAudioContext finds it suspended again. */
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

export function logAudioContextStats(context: AudioContext): void {
  console.info(`AudioContext stats:`);
  console.info(`  Using Global context: ${context === globalAudioContext}`);
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
  const ctx = (context ?? getGlobalAudioContext()) as SinkCapableContext;
  await ctx.setSinkId(deviceId === 'default' ? '' : deviceId);
}

/** Output device id of `context` (default: the global AudioContext). '' means system default. */
export function getCurrentOutputDeviceId(context?: AudioContext): string {
  const { sinkId } = (context ?? getGlobalAudioContext()) as Partial<SinkCapableContext>;
  // AudioSinkInfo ({ type: 'none' }) is silent output, not a device
  return typeof sinkId === 'string' ? sinkId : '';
}
