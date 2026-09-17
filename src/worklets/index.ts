//**  Exports for the main thread **//
export { initProcessors } from './init-processors';
export { processorFileRegistry } from './processor-registry';

//** Audio Param Descriptors **//
export {
  SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS as SAMPLE_PLAYER_PARAM_DESCRIPTORS,
  SAMPLE_PLAYER_WORKLET_AUDIOPARAMS as SAMPLE_PLAYER_PARAMS,
} from './processors/play/sample-player-paramdescriptors';
export type { SamplePlayerWorkletAudioParamKey as SamplePlayerParamKey } from './processors/play/sample-player-paramdescriptors';
