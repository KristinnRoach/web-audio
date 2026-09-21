// =*=*= Factories =*=*= \\
export { createSamplePlayer } from './nodes/instruments/Sample/createSamplePlayer';
export { createAudioRecorder } from './nodes/recorder';
export {
  createEnvelopePlayer,
  EnvelopeRuntime,
  assertValidEnvelope,
  assertValidEnvelopeSettings,
  cloneEnvelopeSettings,
  envelopePresets,
} from './nodes/params/envelopes';

// =*=*= Classes =*=*= \\
export { SamplePlayer } from './nodes/instruments/Sample/SamplePlayer';
export { Oscilloscope } from './nodes/drafts/OscilloScope';

// =*=*=  Types =*=*= \\
export type { Recorder, RecorderInput, RecorderStartOptions } from './nodes/recorder';
export type { LibNode, LibAudioNode, SampleLoader, GainStages } from './nodes';
export type { SamplePlayerOptions } from './nodes/instruments/Sample/SamplePlayer';
export type { SampleVoiceChainNode } from './nodes/instruments/Sample/SampleVoice';
export type {
  Envelope,
  EnvelopeClock,
  EnvelopeMode,
  EnvelopePlayer,
  EnvelopePoint,
  EnvelopeRuntimeTriggerOptions,
  EnvelopeSettings,
  EnvelopeTriggerOptions,
  AutomatableParam,
} from './nodes/params/envelopes';
export type { SampleEnvelopeId } from './nodes/instruments/Sample/temporary-sample-envelope-adapters';

// =*=*= Utilities =*=*= \\
export { getAudioContext, ensureAudioCtx } from './context';
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
  SamplerParamPatch,
} from './nodes/instruments/Sample/sampler-params';

// =*=*= Keyboard mapping =*=*= \\
export { defaultKeymap, generateKeymap, keymaps, DEFAULT_KEYMAP_KEY } from './io/mapping/keymap';
export type { KeymapKey } from './io/mapping/keymap';
export type { KeyMap } from './io/types';

// =*=*= Constants =*=*= \\
export { DEFAULT } from './constants';
export { SUPPORTED_WAVEFORMS } from './utils';
export type { SupportedWaveform } from './utils';
