import { NodeID } from '@/nodes/node-store';
import { ILibAudioNode } from './LibAudioNode';

export type BaseNodeType =
  | 'instrument'
  | 'voice'
  | 'fx'
  | 'param'
  | 'container'
  | 'recorder'
  | 'audiograph';

export type InstrumentType = 'sample-player' | 'synth';

export type ContainerType = 'pool' | 'chain' | 'audiolib';

export type VoiceType =
  | 'sample-voice'
  | 'karplus-strong-voice'
  | 'osc-voice'
  | 'noise-voice';

export type CustomFxType =
  | 'feedback-delay'
  | 'harmonic-feedback'
  | 'distortion'
  | 'dattorro-reverb';

type NativeAudioNode =
  | 'AudioWorkletNode'
  | 'GainNode'
  | 'BiquadFilterNode'
  | 'AudioBufferSourceNode'
  | 'DynamicsCompressorNode';

// Union of all types
export type NodeType =
  | NativeAudioNode
  | BaseNodeType
  | InstrumentType
  | VoiceType
  | ContainerType
  | string
  | CustomFxType;

export type Destination = ILibAudioNode | AudioNode | AudioParam;

export interface SampleLoader {
  loadSample(...args: TODO[]): Promise<TODO>;
}

// Base interface for all nodes
export interface LibNode {
  readonly nodeId: NodeID;
  readonly nodeType: NodeType;
  readonly initialized: boolean;

  dispose(): void;
}
