// =*=*= Factories =*=*= \\
export { createSamplePlayer } from './nodes/instruments/Sample/createSamplePlayer';
export { createAudioRecorder } from './nodes/recorder';

// =*=*= Classes =*=*= \\
export { SamplePlayer } from './nodes/instruments/Sample/SamplePlayer';
export { Oscilloscope } from './nodes/drafts/OscilloScope';

// =*=*=  Types =*=*= \\
export type {
  Recorder,
  RecorderInput,
  RecorderStartOptions,
} from './nodes/recorder';
export type { LibNode, LibAudioNode, SampleLoader } from './nodes';
export type {
  CustomEnvelope,
  EnvelopePoint,
  EnvelopeData,
  EnvelopeType,
} from './nodes/params/envelopes';

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
  SamplerParamPatch,
} from './nodes/instruments/Sample/sampler-params';
export { samplerToggles } from './nodes/instruments/Sample/sampler-toggles';
export type {
  SamplerToggleKey,
  SamplerToggleDescriptor,
} from './nodes/instruments/Sample/sampler-toggles';

// =*=*= Keyboard mapping =*=*= \\
export {
  defaultKeymap,
  generateKeymap,
  keymaps,
  DEFAULT_KEYMAP_KEY,
} from './io/mapping/keymap';
export type { KeymapKey } from './io/mapping/keymap';
export type { KeyMap } from './io/types';

// =*=*= Constants =*=*= \\
export { SUPPORTED_WAVEFORMS } from './utils';
export type { SupportedWaveform } from './utils';

// =*=*= Storage =*=*= \\
// export * as samplelib from './storage/idb'; // Removed to reduce bundle size
