// =*=*= Factories =*=*= \\
export { createSamplePlayer } from './nodes/instruments/Sample/createSamplePlayer';
export { createAudioRecorder } from './nodes/recorder';

// =*=*= Classes =*=*= \\
export { SamplePlayer } from './nodes/instruments/Sample/SamplePlayer';

// =*=*=  Types =*=*= \\
export type { Recorder, RecorderInput, RecorderStartOptions } from './nodes/recorder';
export type { SampleLoader, AudioInput, GainStages } from './nodes';
export type { SamplePlayerOptions } from './nodes/instruments/Sample/SamplePlayer';
export type { SampleVoiceChainNode } from './nodes/instruments/Sample/SampleVoice';
export type { EnvelopeShape, EnvelopeMode, EnvelopePoint } from './nodes/params/envelopes';
export type { EnvelopeConfig } from './nodes/instruments/Sample/envelope-config';
export type { SampleEnvelopeId } from './nodes/instruments/Sample/sample-envelope-policy';

// =*=*= Utilities =*=*= \\
export { getGlobalAudioContext, createGlobalAudioContext } from './context';
export {
  canSetOutputDevice,
  getAudioInputDevices,
  getAudioOutputDevices,
  setAudioOutputDevice,
  getCurrentOutputDeviceId,
} from './context';

// =*=*= Parameter descriptors =*=*= \\
export { samplerParams } from './nodes/instruments/Sample/sampler-params';
export type {
  SamplerParamKey,
  SamplerParamDescriptor,
  SamplerParamValues,
  SamplerParams,
} from './nodes/instruments/Sample/sampler-params';

// =*=*= Keyboard mapping =*=*= \\
export { keymaps, DEFAULT_KEYMAP_KEY } from './io/mapping/keymap';
export type { KeymapKey } from './io/mapping/keymap';
export type { KeyMap } from './io/types';

// =*=*= Constants =*=*= \\
export { SUPPORTED_WAVEFORMS } from './utils';
export type { SupportedWaveform } from './utils';
