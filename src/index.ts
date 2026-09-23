// =*=*= Factories =*=*= \\
export { createSamplePlayer } from './nodes/instruments/Sample/createSamplePlayer';
export { createAudioRecorder } from './nodes/recorder';
export { assertValidEnvelopeShape, envelopePresets } from './nodes/params/envelopes';

// =*=*= Classes =*=*= \\
export { SamplePlayer } from './nodes/instruments/Sample/SamplePlayer';
export { Oscilloscope } from './nodes/drafts/OscilloScope';
export { Envelope } from './nodes/params/envelopes';

// =*=*=  Types =*=*= \\
export type { Recorder, RecorderInput, RecorderStartOptions } from './nodes/recorder';
export type { LibNode, LibAudioNode, SampleLoader, GainStages } from './nodes';
export type { SamplePlayerOptions } from './nodes/instruments/Sample/SamplePlayer';
export type { SampleVoiceChainNode } from './nodes/instruments/Sample/SampleVoice';
export type {
  EnvelopeShape,
  EnvelopeClock,
  EnvelopeMode,
  EnvelopePoint,
  EnvelopeTriggerOptions,
  AutomatableParam,
} from './nodes/params/envelopes';
export type { EnvelopeConfig } from './nodes/instruments/Sample/envelope-config';
export type { SampleEnvelopeId } from './nodes/instruments/Sample/sample-envelope-policy';

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
