import { ILibAudioNode } from '../LibAudioNode';
import { NodeType } from '@/nodes/LibNode';
import { getAudioContext } from '@/context';
import { registerNode, NodeID, unregisterNode } from '@/nodes/node-store';

import { mapToRange, clamp } from '@/utils';

type DattorroReverbPresetKey = keyof typeof DattorroReverb.PRESETS;

export class DattorroReverb implements ILibAudioNode {
  readonly nodeId: NodeID;
  readonly nodeType: NodeType = 'dattorro-reverb';
  #initialized = false;
  #context: AudioContext;

  #connections = new Set<NodeID>();
  #incoming = new Set<NodeID>();

  #reverb: AudioWorkletNode;
  #currentPreset: DattorroReverbPresetKey = 'default';

  static readonly PRESETS = {
    // currently omitting 'wet' param

    room: {
      preDelay: 1525,
      bandwidth: 0.5683,
      inputDiffusion1: 0.4666,
      inputDiffusion2: 0.5853,
      decay: 0.3226,
      decayDiffusion1: 0.6954,
      decayDiffusion2: 0.6022,
      damping: 0.6446,
      excursionRate: 0,
      excursionDepth: 0,
    },
    church: {
      preDelay: 0,
      bandwidth: 0.928,
      inputDiffusion1: 0.7331,
      inputDiffusion2: 0.4534,
      decay: 0.7,
      decayDiffusion1: 0.7839,
      decayDiffusion2: 0.1992,
      damping: 0.5975,
      excursionRate: 0,
      excursionDepth: 0,
    },
    freeze: {
      preDelay: 0,
      bandwidth: 0.999,
      inputDiffusion1: 0.75,
      inputDiffusion2: 0.625,
      decay: 1,
      decayDiffusion1: 0.5,
      decayDiffusion2: 0.711,
      damping: 0.005,
      excursionRate: 0.3,
      excursionDepth: 1.4,
    },
    ether: {
      preDelay: 0,
      bandwidth: 0.999,
      inputDiffusion1: 0.23,
      inputDiffusion2: 0.667,
      decay: 0.45,
      decayDiffusion1: 0.7,
      decayDiffusion2: 0.5,
      damping: 0.3,
      excursionRate: 0.85,
      excursionDepth: 1.2,
    },
    default: {
      // Note: WIP
      preDelay: 0,
      bandwidth: 0.85, // -bandwith === pre LPF !
      inputDiffusion1: 0.4,
      inputDiffusion2: 0.45,
      decay: 0.1,
      decayDiffusion1: 0.5,
      decayDiffusion2: 0.45,
      damping: 0.25,
      excursionRate: 0.3,
      excursionDepth: 0.3,
    },

    // get default() {
    //   return this.room;
    // },
  } as const;

  constructor(context: AudioContext = getAudioContext()) {
    this.nodeId = registerNode(this.nodeType, this);
    this.#context = context;

    this.#reverb = new AudioWorkletNode(context, 'dattorro-reverb-processor', {
      outputChannelCount: [2], // NOTE: Currently ONLY supports stereo output
    });

    this.setParam('dry', 0); // Only using wet! (consider removing dry from processor)

    this.setAmountMacro(0.01);
  }

  connect(destination: ILibAudioNode | AudioNode): void {
    const target = 'input' in destination ? destination.input : destination;
    this.#reverb.connect(target as AudioNode);

    if ('nodeId' in destination) {
      this.#connections.add(destination.nodeId);
      (destination as any).addIncoming?.(this.nodeId);
    }
  }

  disconnect(destination?: ILibAudioNode | AudioNode): void {
    if (destination) {
      const target = 'input' in destination ? destination.input : destination;
      this.#reverb.disconnect(target as AudioNode);
      if ('nodeId' in destination) {
        this.#connections.delete(destination.nodeId);
        (destination as any).removeIncoming?.(this.nodeId);
      }
    } else {
      // Disconnect all
      this.#reverb.disconnect();
      this.#connections.clear();
    }
  }

  addIncoming(source: ILibAudioNode): void {
    this.#incoming.add(source.nodeId);
  }

  removeIncoming(source: ILibAudioNode): void {
    this.#incoming.delete(source.nodeId);
  }

  // === SETTERS ===

  setParam(name: string, value: number, time = this.now): void {
    if (!isFinite(value)) {
      console.warn(`Skipping non-finite value for ${name}:`, value);
      return;
    }

    // Handle macro parameters
    if (name === 'size') {
      this.setAmountMacro(value);
      return;
    }

    if (name === 'diffusion') {
      this.setDiffusionMacro(value);
      return;
    }

    // Direct worklet parameters
    this.#reverb.parameters.get(name)?.setValueAtTime(value, time);
  }

  getAudioParam(name: string): AudioParam | null {
    // Handle macro parameters
    if (name === 'diffusion') {
      // Return a mock AudioParam-like object for consistency
      return {
        value: this.getDiffusionMacroValue(),
        setValueAtTime: (value: number, time: number) =>
          this.setDiffusionMacro(value),
      } as any;
    }

    return this.#reverb.parameters.get(name) || null;
  }

  setAmountMacro(amount: number) {
    if (amount < 0 || amount > 1) {
      console.warn('Reverb amount must be 0-1 range');
      return;
    }

    const presetValues = DattorroReverb.PRESETS[this.#currentPreset];

    // Map amount (0-1) to scale from preset value up to max
    const decay = mapToRange(amount, 0, 1, presetValues.decay, 0.93);

    const excRate = mapToRange(amount, 0, 1, presetValues.excursionRate, 2);

    const excDepth = mapToRange(amount, 0, 1, presetValues.excursionDepth, 2);

    const damping = mapToRange(amount, 0, 1, presetValues.damping, 0.65);
    const preLPF = mapToRange(amount, 0, 1, presetValues.bandwidth, 0.2);
    const diffusion = mapToRange(amount, 0, 1, 0.3, 1);

    // console.table({ decay, excRate, excDepth, damping, preLPF, diffusion });

    this.setDiffusionMacro(diffusion);
    this.getAudioParam('decay')?.setTargetAtTime(decay, this.now, 0.1);
    this.setParam('excursionRate', excRate);
    this.setParam('excursionDepth', excDepth);
    this.setParam('damping', damping);
    this.setParam('bandwidth', preLPF);
  }

  setPreset(
    preset: 'room' | 'church' | 'freeze' | 'ether' | 'default' = 'default',
    rampTime = 0.5
  ): void {
    this.#currentPreset = preset;
    const values = DattorroReverb.PRESETS[preset];
    const currentTime = this.#reverb.context.currentTime;

    Object.entries(values).forEach(([paramName, value]) => {
      const param = this.#reverb.parameters.get(paramName);
      if (param) {
        param.linearRampToValueAtTime(value, currentTime + rampTime);
      } else {
        console.warn(`Parameter '${paramName}' not found in reverb node`);
      }
    });
  }

  /** 
    DIFFUSION PARAMETER (0.0 - 1.0, default: 0.7)
    Controls reverb density and scatter. Higher = more complex tail.

    0.0 - No diffusion, echoes/delays only        | Special effects, rhythmic delays
    0.3 - Light scatter, clear open sound         | Vocals, acoustic instruments  
    0.5 - Moderate density, balanced              | General purpose, drums
    0.7 - Rich diffusion, full reverb tail        | Orchestral, ambient music
    0.9 - Very dense, thick complex tail          | Dense mixes, sound design
    1.0 - Maximum density, can sound harsh        | Experimental/aggressive sounds
  **/
  setDiffusionMacro(value: number) {
    const fi = Math.max(0.1, value * 0.75);
    const si = Math.max(0.1, value * 0.625);
    const ft = Math.min(0.7, Math.max(0.1, value * 0.6));
    const st = Math.max(0.2, value * 0.4);

    this.setParam('inputDiffusion1', fi);
    this.setParam('inputDiffusion2', si);
    this.setParam('decayDiffusion1', ft);
    this.setParam('decayDiffusion2', st);
  }

  getDiffusionMacroValue(): number {
    // Return approximate macro value based on current inputDiffusion1
    const fi = this.getAudioParam('inputDiffusion1')?.value ?? 0.75;
    return (fi - 0.1) / (0.75 - 0.1); // Reverse the mapping
  }

  // === GETTERS ===

  getCurrentSettings(): Record<string, number> {
    const result: Record<string, number> = {};

    Array.from(this.#reverb.parameters.keys()).forEach((paramName) => {
      result[paramName] = this.#reverb.parameters.get(paramName)?.value ?? 0;
    });

    return result;
  }

  get audioNode() {
    return this.#reverb;
  }

  get context() {
    return this.#context;
  }

  get input(): AudioNode {
    return this.#reverb;
  }

  get output(): AudioNode {
    return this.#reverb;
  }

  get now() {
    return this.#reverb.context.currentTime;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get currentPreset() {
    return this.#currentPreset;
  }

  get connections() {
    return {
      outgoing: Array.from(this.#connections),
      incoming: Array.from(this.#incoming),
    };
  }

  get numberOfInputs() {
    return this.input.numberOfInputs;
  }

  get numberOfOutputs() {
    return this.output.numberOfOutputs;
  }

  get workletInfo() {
    return {
      numberOfInputs: this.#reverb.numberOfInputs,
      numberOfOutputs: this.#reverb.numberOfOutputs,
      channelCount: this.#reverb.channelCount,
      channelCountMode: this.#reverb.channelCountMode,
    };
  }

  dispose(): void {
    this.disconnect();
    unregisterNode(this.nodeId);
  }
}
