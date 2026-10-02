// globalAudioContext.ts

import { assert } from '@/utils';

let globalAudioContext: AudioContext | null = null;
// Reused when getGlobalAudioContext replaces a closed global context. Empty by
// default, so the browser uses the output device's native sample rate.
let globalOptions: AudioContextOptions = {};
let autoResumeArmed = false;

/** Throws while a global context is open. To change options, dispose the nodes on it
 *  and `await` its `close()` first: `state` only becomes 'closed' once that resolves. */
export function createGlobalAudioContext(options: AudioContextOptions = {}): AudioContext {
  assert(
    !globalAudioContext || globalAudioContext.state === 'closed',
    'A global AudioContext already exists. Use getGlobalAudioContext(), or await its close() before creating a new one.',
  );
  globalOptions = options;
  globalAudioContext = new AudioContext(globalOptions);
  if (globalAudioContext.state === 'suspended') armAutoResume();
  return globalAudioContext;
}

/** Creates the global context on first use, or replaces a closed one using the last
 *  options. May return it suspended; the next user gesture resumes it. */
export function getGlobalAudioContext(): AudioContext {
  if (!globalAudioContext || globalAudioContext.state === 'closed') {
    return createGlobalAudioContext(globalOptions);
  }
  if (globalAudioContext.state === 'suspended') armAutoResume();
  return globalAudioContext;
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
