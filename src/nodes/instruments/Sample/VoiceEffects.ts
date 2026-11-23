import { LibAudioNode, Destination, NodeType } from '@/nodes';
import { DEFAULT } from '@/constants';
import { registerNode, NodeID, unregisterNode } from '@/nodes/node-store';

import { assert, mapToRange } from '@/utils';
import { HarmonicFeedback } from '@/nodes/effects/HarmonicFeedback';
import { clampHz, durationToTimeConstant, maxSafeHz } from '@/nodes/params/audioparam-utils';
import { LFO } from '@/nodes/modulators/LFO/LFO';
import { CustomLibWaveform, WaveformOptions } from '@/utils/audiodata/generate/generateWaveform';
import { samplerParams } from './sampler-params';

export type SampleVoiceChainNode = 'feedback' | 'am' | 'hpf' | 'lpf';

const DEFAULT_CHAIN_ORDER: readonly SampleVoiceChainNode[] = ['am', 'hpf', 'feedback', 'lpf'];

/**
 * One voice's main-thread effect chain, fed by that voice's processor output.
 * `SamplePlayer` owns the voice; feedback and the AM LFO follow the notes it hands over.
 */
export class VoiceEffects {
  readonly nodeId: NodeID;
  readonly nodeType: NodeType = 'sample-voice';
  /** LibNode: the chain is built in the constructor. */
  readonly initialized = true;

  #outputNode: GainNode;
  /** This voice's audio as it leaves the processor. */
  #source: GainNode;

  #am_lfo: LFO | null = null;
  #am_lfo_semitone_offset: number = samplerParams.amModOctaveOffset.defaultValue * 12;
  #am_gain: GainNode | null = null;
  #feedback: HarmonicFeedback | null = null;

  /** Semitones added to the played note for the effects that track pitch; the processor applies its own. */
  #pitchOffset = 0;

  #internalSignalChain: readonly SampleVoiceChainNode[];

  #hpf: BiquadFilterNode | null = null;
  #lpf: BiquadFilterNode | null = null;

  /** Wires voice `voiceIndex` of the player's processor through the chain. */
  constructor(
    private context: BaseAudioContext,
    worklet: AudioWorkletNode,
    voiceIndex: number,
    signalChain: readonly SampleVoiceChainNode[] = DEFAULT_CHAIN_ORDER,
  ) {
    if (new Set(signalChain).size !== signalChain.length) {
      throw new TypeError('Voice signal chain cannot contain duplicate nodes');
    }

    this.nodeId = registerNode(this.nodeType, this);
    this.#internalSignalChain = [...signalChain];

    this.#outputNode = new GainNode(context, { gain: 1 });
    this.#source = new GainNode(context, { gain: 1 });

    try {
      this.#initInternalSignalChainNodes();
      this.#connectAudioChain(worklet, voiceIndex);
    } catch (error) {
      this.dispose(); // or the registration outlives a voice nobody holds
      throw error;
    }
  }

  /**
   * Each chain entry as the pair of nodes the signal enters and leaves by.
   * Nodes with an internal path (HarmonicFeedback) expose different faces;
   * connecting one's input straight to its output would bypass that path.
   */
  #chainStages(): { name: string; in: AudioNode; out: AudioNode }[] {
    const map: Record<SampleVoiceChainNode, AudioNode | HarmonicFeedback | null> = {
      feedback: this.#feedback,
      am: this.#am_gain,
      hpf: this.#hpf,
      lpf: this.#lpf,
    };
    return this.#internalSignalChain.map((name) => {
      const node = map[name];
      assert(node, `VoiceEffects: "${name}" not initialized!`);
      return node instanceof HarmonicFeedback
        ? { name, in: node.input, out: node.output }
        : { name, in: node, out: node };
    });
  }

  #connectAudioChain(worklet: AudioWorkletNode, voiceIndex: number) {
    const stages = [
      { name: 'worklet', in: this.#source as AudioNode, out: this.#source as AudioNode },
      ...this.#chainStages(),
      { name: 'out', in: this.#outputNode as AudioNode, out: this.#outputNode as AudioNode },
    ];
    for (let i = 0; i < stages.length - 1; i++) stages[i].out.connect(stages[i + 1].in);
    // Each voice has two outputs: its audio, then its filter envelope in cents.
    worklet.connect(this.#source, voiceIndex * 2);
    // Sums with lpf.detune's own value, so it stays 0 while the filter envelope is off.
    if (this.#lpf) worklet.connect(this.#lpf.detune, voiceIndex * 2 + 1);
  }

  /**
   * Named tap points along this voice's internal chain, in signal order.
   * Pass to `monitorLevels` from `@kidlib/web-audio/debug`.
   */
  getGainStages(): Record<string, AudioNode> {
    return {
      worklet: this.#source,
      ...Object.fromEntries(this.#chainStages().map(({ name, out }) => [name, out])),
      out: this.#outputNode,
    };
  }

  #chainIncludes(node: SampleVoiceChainNode) {
    return this.#internalSignalChain.includes(node);
  }

  #initInternalSignalChainNodes() {
    if (this.#chainIncludes('feedback')) {
      this.#feedback = new HarmonicFeedback(this.context);
    }

    if (this.#chainIncludes('am')) {
      this.#am_gain = new GainNode(this.context, { gain: 1 });
      this.#am_lfo = new LFO(this.context);
      this.#am_lfo.setWaveform('pulse');
      this.#am_lfo.setDepth(0);
      this.#am_lfo.setMusicalNote(60 + this.#pitchOffset + this.#am_lfo_semitone_offset);
      this.#am_lfo.connect(this.#am_gain.gain);
    }

    if (this.#chainIncludes('hpf')) {
      this.#hpf = new BiquadFilterNode(this.context, {
        type: 'highpass',
        frequency: samplerParams.highpassFilter.defaultValue,
        Q: DEFAULT.HPF_Q,
      });
    }

    if (this.#chainIncludes('lpf')) {
      this.#lpf = new BiquadFilterNode(this.context, {
        type: 'lowpass',
        frequency: maxSafeHz(this.context.sampleRate),
        Q: DEFAULT.LPF_Q,
      });
    }
  }

  /** Retunes the held note's feedback and AM LFO; `heldNote` is null while the voice is free. */
  setPitchOffset(semitones: number, heldNote: number | null) {
    if (this.#pitchOffset === semitones) return;
    this.#pitchOffset = semitones;
    if (heldNote !== null) {
      this.followNote(heldNote, {
        timestamp: this.context.currentTime,
        glideTime: 0.01,
        retuned: true,
      });
    }
  }

  /**
   * Moves feedback and the AM LFO to a played note; they add the pitch offset.
   * A new note restarts feedback decay and the LFO may glide from `glideFromNote`.
   * With `retuned`, the sounding note only changes pitch.
   */
  followNote(
    midiNote: number,
    note: {
      timestamp: number;
      glideTime: number;
      retuned?: boolean;
      glideFromNote?: number | null;
    },
  ) {
    const { timestamp, glideTime, retuned = false, glideFromNote = null } = note;
    const soundingNote = midiNote + this.#pitchOffset;
    const amNote = soundingNote + this.#am_lfo_semitone_offset;
    if (retuned) {
      this.#feedback?.setPitch(soundingNote, 0, timestamp, glideTime);
      this.#am_lfo?.setMusicalNote(amNote, { timestamp, glideTime });
      return;
    }

    this.#feedback?.trigger(soundingNote, {
      secondsFromNow: Math.max(0, timestamp - this.context.currentTime),
      glideTime,
      triggerDecay: true,
    });

    this.#am_lfo?.setMusicalNote(amNote, {
      divisor: 1,
      glideTime,
      glideFromMidiNote:
        glideFromNote === null
          ? undefined
          : glideFromNote + this.#pitchOffset + this.#am_lfo_semitone_offset,
      timestamp,
    });
  }

  // === LFOs ===

  setModulationDepth(modType: 'AM' | 'FM', depth: number) {
    if (modType === 'AM' && !this.#chainIncludes('am')) return this;

    const safeDepth = mapToRange(depth, 0, 1, 0, 0.95, {
      warn: true,
      name: 'voiceEffects.setModulationDepth',
    });

    if (modType === 'AM') {
      // Dips below unity instead of boosting above it: gain stays in [1 - depth, 1].
      this.#am_gain?.gain.setValueAtTime(1 - safeDepth / 2, this.context.currentTime);
      this.#am_lfo?.setDepth(safeDepth / 2);
    } else if (modType === 'FM') {
      console.warn('VoiceEffects: FM modulation not implemented yet');
    }
    return this;
  }

  setModulationWaveform(
    modType: 'AM' | 'FM' = 'AM',
    waveform: CustomLibWaveform | OscillatorType | PeriodicWave = 'triangle',
    customWaveOptions: WaveformOptions = {},
  ) {
    if (modType === 'AM' && !this.#chainIncludes('am')) return this;

    if (modType === 'AM') {
      this.#am_lfo?.setWaveform(waveform, customWaveOptions);
    } else if (modType === 'FM') {
      console.info('VoiceEffects: FM modulation not implemented yet');
    }
    return this;
  }

  /** CONNECTIONS */

  connect(destination: Destination, output?: number, input?: number): Destination {
    if (destination instanceof LibAudioNode) {
      this.#outputNode.connect(destination.input, output);
    } else if (destination instanceof AudioParam) {
      this.#outputNode.connect(destination, output);
    } else if (destination instanceof AudioNode) {
      this.#outputNode.connect(destination, output, input);
    } else {
      console.warn('VoiceEffects: Unsupported destination', destination);
    }
    return destination;
  }

  disconnect(destination?: Destination): this {
    if (!destination) {
      this.#outputNode.disconnect();
    } else if (destination instanceof AudioNode) {
      this.#outputNode.disconnect(destination);
    } else if (destination instanceof AudioParam) {
      this.#outputNode.disconnect(destination);
    }
    return this;
  }

  get feedback() {
    return this.#feedback;
  }

  /**
   * @param options.glideTime Ramp duration in seconds. For the filter cutoffs this is
   * converted to a `setTargetAtTime` time constant (glideTime / 3), so the cutoff is
   * ~95% settled at `glideTime`. When omitted, DEFAULT.CUTOFF_SMOOTHING_SEC is used as
   * the time constant itself, so the cutoff is ~95% settled after 3x that.
   * @param options.cancelPrevious Clear automation already scheduled on the param.
   * Defaults to true. Pass false to let a running envelope or LFO ramp survive.
   */
  setHpfCutoff(
    hz: number,
    atTime: number = this.context.currentTime,
    options: { glideTime?: number; cancelPrevious?: boolean } = {},
  ) {
    if (this.#hpf) {
      const timeConstant = durationToTimeConstant(options.glideTime, DEFAULT.CUTOFF_SMOOTHING_SEC);
      if (options.cancelPrevious ?? true) this.#hpf.frequency.cancelScheduledValues(atTime);
      this.#hpf.frequency.setTargetAtTime(
        clampHz(hz, this.context.sampleRate),
        atTime,
        timeConstant,
      );
    }
    return this;
  }

  /** Same options as `setHpfCutoff`. */
  setLpfCutoff(
    hz: number,
    atTime: number = this.context.currentTime,
    options: { glideTime?: number; cancelPrevious?: boolean } = {},
  ) {
    if (this.#lpf) {
      const timeConstant = durationToTimeConstant(options.glideTime, DEFAULT.CUTOFF_SMOOTHING_SEC);
      if (options.cancelPrevious ?? true) this.#lpf.frequency.cancelScheduledValues(atTime);
      this.#lpf.frequency.setTargetAtTime(
        clampHz(hz, this.context.sampleRate),
        atTime,
        timeConstant,
      );
    }
    return this;
  }

  /** `heldNote` is null while the voice is free; a held note's LFO moves at once. */
  setAMModOctaveOffset(offset: number, heldNote: number | null) {
    assert(
      offset >= samplerParams.amModOctaveOffset.min &&
        offset <= samplerParams.amModOctaveOffset.max,
      `AM modulation octave offset must be between ${samplerParams.amModOctaveOffset.min} and ${samplerParams.amModOctaveOffset.max}`,
    );
    const semitoneOffset = offset * 12; // convert octaves to semitones
    this.#am_lfo_semitone_offset = semitoneOffset;
    if (this.#am_lfo && heldNote !== null) {
      this.#am_lfo.setMusicalNote(heldNote + this.#pitchOffset + semitoneOffset);
    }
  }

  dispose(): void {
    this.disconnect();
    this.#am_lfo?.dispose();
    this.#am_lfo = null;
    this.#feedback?.dispose();
    unregisterNode(this.nodeId);
  }

  getParam(name: string): AudioParam | null {
    switch (name) {
      case 'highpass':
      case 'hpf':
        return this.#hpf?.frequency ?? null;
      case 'lowpass':
      case 'lpf':
        return this.#lpf?.frequency ?? null;
      case 'hpfQ':
        return this.#hpf?.Q ?? null;
      case 'lpfQ':
        return this.#lpf?.Q ?? null;
      default:
        return null;
    }
  }
}
