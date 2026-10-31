import { LibAudioNode, Destination, NodeType } from '@/nodes';
import { DEFAULT } from '@/constants';
import { registerNode, NodeID, unregisterNode } from '@/nodes/node-store';
import { VoiceState } from '../VoiceState';

import { Message, MessageHandler, createMessageBus, MessageBus } from '@/events';

import { assert, mapToRange, midiToPlaybackRate, getKeytrackedFilterHz } from '@/utils';
import { HarmonicFeedback } from '@/nodes/effects/HarmonicFeedback';
import {
  cancelAndPinParamValue,
  clampHz,
  durationToTimeConstant,
  maxSafeHz,
} from '@/nodes/params/audioparam-utils';
import { Envelope } from '@/nodes/modulators/envelope';
import type { EnvelopeConfig } from './envelope-config';
import { LFO } from '@/nodes/modulators/LFO/LFO';
import { CustomLibWaveform, WaveformOptions } from '@/utils/audiodata/generate/generateWaveform';
import { samplerParams } from './sampler-params';
import {
  createDefaultSampleEnvelopeConfig,
  getSampleEnvelopeRestValue,
  getSampleEnvelopeIds,
  getSampleEnvelopeParamName,
  resolveSampleEnvelopeTrigger,
  type SampleEnvelopeId,
} from './sample-envelope-policy';

export type SampleVoiceChainNode = 'feedback' | 'am' | 'hpf' | 'lpf';
export type TimestretchMode = 'off' | 'splice';

const DEFAULT_CHAIN_ORDER: readonly SampleVoiceChainNode[] = ['am', 'hpf', 'feedback', 'lpf'];

/** Time constant for the gate fade when the amp envelope is off:
 * fast enough to read as a gate, slow enough not to click. */
const AMP_GATE_SMOOTHING_SEC = 0.002;

export class SampleVoice {
  // TODO: implements ILibAudioNode
  readonly nodeId: NodeID;
  readonly nodeType: NodeType = 'sample-voice';
  #messages: MessageBus<Message>;
  #initPromise: Promise<void> | null = null;

  #outputNode: GainNode;
  #playerWorklet: AudioWorkletNode;

  #am_lfo: LFO | null = null;
  #am_lfo_semitone_offset: number = samplerParams.amModOctaveOffset.defaultValue * 12;
  #am_gain: GainNode | null = null;
  #feedback: HarmonicFeedback | null = null;

  #envelopes = new Map<SampleEnvelopeId, Envelope>();
  /** Host policy the envelope does not know about: `enabled`, `timeScale`, `playbackRateSync` and `loopSync`. */
  #envelopeConfigs = new Map<SampleEnvelopeId, EnvelopeConfig>();

  #state: VoiceState = VoiceState.AVAILABLE;
  #isInitialized = false;

  // Set once `voice:setAudioData` is on the wire rather than on the processor's
  // `voice:loaded` ack: the port preserves order, so a `voice:start` posted in
  // the round trip still arrives after the audio data is in place.
  #hasLoadedAudio = false;

  #midiNote: number | null = null;
  #startedTimestamp: number = -1;
  #triggerId = 0;

  #sampleDurationSeconds = 0;
  #loopEnabled = false;
  /**
   * Buffer-time loop length after snapping, pitch quantization and minimum lengths.
   * Reported while idle for the next note; 0 until the processor reports it.
   */
  #processedLoopSeconds = 0;
  /** Loop keytrack in effect for the idle length, which is resolved at rate 1. */
  #idleLoopKeytrack = 0;

  #pitchGlideTime = 0; // in seconds
  /** Semitones added to the played note for everything that tracks pitch. */
  #pitchOffset = 0;

  #internalSignalChain: readonly SampleVoiceChainNode[];
  #pitchDisabled = false;

  #hpf: BiquadFilterNode | null = null;
  #lpf: BiquadFilterNode | null = null;
  #hpfHz: number = samplerParams.highpassFilter.defaultValue;
  #hpfQ: number = DEFAULT.HPF_Q;
  #lpfHz: number = maxSafeHz();
  #lpfQ: number = DEFAULT.LPF_Q;
  // Keytracking off by default: it fought the post-FX filter envelope by moving the
  // cutoff the sweep starts from. Was 0.25 / 0.75, tuned by ear.
  // TODO: Consider adding as params (#31)
  #keytrackLPFAmount: number = 0;
  #keytrackHPFAmount: number = 0;

  // static getProcessorParamDescriptors() {
  //   return SAMPLE_PLAYER_PARAM_DESCRIPTORS;
  // }

  constructor(
    private context: AudioContext,
    options: { processorOptions?: any; internalSignalChain?: readonly SampleVoiceChainNode[] } = {},
  ) {
    const signalChain = options.internalSignalChain ?? DEFAULT_CHAIN_ORDER;
    if (new Set(signalChain).size !== signalChain.length) {
      throw new TypeError('SampleVoice signal chain cannot contain duplicate nodes');
    }

    this.nodeId = registerNode(this.nodeType, this);
    this.#messages = createMessageBus<Message>(this.nodeId);
    this.#internalSignalChain = [...signalChain];

    this.#outputNode = new GainNode(context, { gain: 1 });

    this.#playerWorklet = new AudioWorkletNode(context, 'sample-player-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2], // Force stereo output
      processorOptions: options.processorOptions || {},
    });

    // Connections are made in #connectAudioChain() during init()
  }

  async init(): Promise<void> {
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = (async () => {
      try {
        // ? Need to wait for worklet 'initialized' message ?

        // Create nodes
        this.#initInternalSignalChainNodes();

        // Connect nodes
        this.#connectAudioChain();

        // Create Envelopes // Todo: follow async pattern to the end
        this.#createEnvelopes();

        // Setup message handling
        this.#setupWorkletMessageHandling();
        this.#playerWorklet.port.start();
      } catch (error) {
        this.dispose();
        this.#initPromise = null;
        throw error;
      }
    })();
    return this.#initPromise;
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
      assert(node, `SampleVoice: "${name}" not initialized!`);
      return node instanceof HarmonicFeedback
        ? { name, in: node.input, out: node.output }
        : { name, in: node, out: node };
    });
  }

  #connectAudioChain() {
    const stages = [
      { name: 'worklet', in: this.#playerWorklet, out: this.#playerWorklet as AudioNode },
      ...this.#chainStages(),
      { name: 'out', in: this.#outputNode as AudioNode, out: this.#outputNode as AudioNode },
    ];
    for (let i = 0; i < stages.length - 1; i++) stages[i].out.connect(stages[i + 1].in);
  }

  /**
   * Named tap points along this voice's internal chain, in signal order.
   * Pass to `monitorLevels` from `@kidlib/web-audio/debug`.
   */
  getGainStages(): Record<string, AudioNode> {
    return {
      worklet: this.#playerWorklet,
      ...Object.fromEntries(this.#chainStages().map(({ name, out }) => [name, out])),
      out: this.#outputNode,
    };
  }

  #chainIncludes(node: SampleVoiceChainNode) {
    return this.#internalSignalChain.includes(node);
  }

  #initInternalSignalChainNodes() {
    if (this.#chainIncludes('feedback') && !this.#feedback) {
      this.#feedback = new HarmonicFeedback(this.context);
    }

    if (this.#chainIncludes('am') && !this.#am_gain) {
      this.#am_gain = new GainNode(this.context, { gain: 1 });
      this.#am_lfo = new LFO(this.context);
      this.#am_lfo.setWaveform('pulse');
      this.#am_lfo.setDepth(0);
      this.#am_lfo.setMusicalNote(
        (this.#midiNote ?? 60) + this.#pitchOffset + this.#am_lfo_semitone_offset,
      );
      this.#am_lfo.connect(this.#am_gain.gain);
    }

    if (this.#chainIncludes('hpf') && !this.#hpf) {
      this.#hpf = new BiquadFilterNode(this.context, {
        type: 'highpass',
        frequency: this.#hpfHz,
        Q: this.#hpfQ,
      });
    }

    if (this.#chainIncludes('lpf') && !this.#lpf) {
      this.#lpfHz = maxSafeHz(this.context.sampleRate);
      this.#lpf = new BiquadFilterNode(this.context, {
        type: 'lowpass',
        frequency: this.#lpfHz,
        Q: this.#lpfQ,
      });
    }
  }

  #createEnvelopes() {
    this.#envelopes.forEach((env) => env.stop());
    this.#envelopes.clear();
    this.#envelopeConfigs.clear();

    const durationSeconds = this.#sampleDurationSeconds || 1;
    const types = getSampleEnvelopeIds(this.#chainIncludes('lpf'));

    for (const type of types) {
      // Envelopes start from defaults; SamplePlayer pushes the real state down as soon
      // as it has one, which is also what keeps every voice on the same shape.
      const config = createDefaultSampleEnvelopeConfig(type, durationSeconds);
      const param = this.getParam(getSampleEnvelopeParamName(type));
      if (!param) continue;
      this.#envelopes.set(type, new Envelope(this.context, param, config.shape));
      this.#envelopeConfigs.set(type, config);
    }
  }

  async loadBuffer(buffer: AudioBuffer, zeroCrossings?: number[]): Promise<boolean> {
    return this.loadAudioData([buffer], zeroCrossings);
  }

  /**
   * Replace all loaded audio data. Entries are summed at one shared playhead,
   * so index 0 is the authority for duration and all range math; the rest only
   * add samples. An entry at the wrong sample rate is dropped on its own,
   * leaving the others playable, except index 0: losing it fails the load.
   */
  async loadAudioData(buffers: AudioBuffer[], zeroCrossings?: number[]): Promise<boolean> {
    const usable = buffers.filter((buffer) => {
      if (buffer.sampleRate !== this.context.sampleRate) {
        console.warn(
          `Sample rate mismatch - buffer: ${buffer.sampleRate}, context: ${this.context.sampleRate}`,
        );
        return false;
      }
      return true;
    });

    // Index 0 is the authority for duration and loop range, so if it was
    // dropped the remaining entries would silently play to the wrong ranges.
    if (!usable.length || usable[0] !== buffers[0]) {
      console.error(
        'SampleVoice.loadAudioData: audio data 0 is unusable, nothing loaded. Index 0 sets duration and loop range for all entries.',
      );
      return false;
    }

    // postMessage structured-clones each channel, so no local copy needed
    const audioData = usable.map((buffer) =>
      Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
    );

    // The processor drops isPlaying when it swaps audio data and never echoes a
    // stop for it, so end the note here or the voice stays PLAYING in silence.
    this.stop();

    this.sendToProcessor({
      type: 'voice:setAudioData',
      audioData,
      durationSeconds: usable[0].duration,
    });
    this.#hasLoadedAudio = true;

    if (zeroCrossings?.length) {
      this.sendToProcessor({
        type: 'voice:setZeroCrossings',
        zeroCrossings,
      });
    }

    return true;
  }

  /** Retunes a held note too: rate, keytracked filters and the AM LFO follow. */
  setPitchOffset(semitones: number): this {
    if (this.#pitchOffset === semitones) return this;
    this.#pitchOffset = semitones;
    if (this.#midiNote === null) return this;
    if (!this.#pitchDisabled) {
      const rate = midiToPlaybackRate(this.#midiNote + semitones);
      const glide = { glideTime: 0.01 };
      this.setParam('playbackRate', rate, this.now, glide);
      this.#updateHPFCutoffForPlaybackRate(rate, this.now, glide);
      this.#updateLPFCutoffForPlaybackRate(rate, this.now, glide);
    }
    this.#am_lfo?.setMusicalNote(this.#midiNote + semitones + this.#am_lfo_semitone_offset);
    return this;
  }

  freeze(freeze: boolean): this {
    console.info(
      `SampleVoice: freeze(${freeze}) called. 
      Spectral freeze not implemented yet`,
    );
    // if (this.#isFrozen === freeze) return this; // idempotent
    // this.#isFrozen = freeze;
    // this.#spectralFreezeWorklet.port.postMessage(
    //   freeze ? 'freeze' : 'unfreeze'
    // );
    return this;
  }

  setGlideTime(seconds: number) {
    this.#pitchGlideTime = seconds;
  }

  trigger(options: {
    midiNote: MidiValue;
    velocity: MidiValue;
    secondsFromNow?: number;
    glide?: { prevMidiNote: number; glideTime?: number };
  }): MidiValue | null {
    if (!this.#hasLoadedAudio) return null;
    const { midiNote, velocity, secondsFromNow = 0 } = options;
    const timestamp = this.now + secondsFromNow;

    if (this.#state !== VoiceState.AVAILABLE) {
      console.log(`had to stop a playing voice, midinote: ${midiNote}`);
      this.stop(timestamp);
      return null;
    }

    // A reused voice can still have a stop or release scheduled against the
    // note it just finished. Left armed, they fire into this note and cut it.
    this.#transitionTo(VoiceState.PLAYING, {
      midiNote,
      startedTimestamp: timestamp,
    });

    const GLIDE_TEMP_SCALAR = 8; // for easy fine-tuning while prototyping the glide feature
    const glideTime = options.glide?.glideTime ?? this.#pitchGlideTime;
    const scaledGlideTime = glideTime / GLIDE_TEMP_SCALAR;

    let playbackRate = 1;
    let prevRate = 1;

    const soundingNote = midiNote + this.#pitchOffset;
    if (!this.#pitchDisabled) {
      playbackRate = midiToPlaybackRate(soundingNote);
      if (options.glide) {
        prevRate = midiToPlaybackRate(options.glide.prevMidiNote + this.#pitchOffset);
      }
      this.#updateHPFCutoffForPlaybackRate(playbackRate, timestamp, {
        glideTime: scaledGlideTime,
        // cancelPrevious: !!options.glide, // ? cancel previous only if glide is requested ?
      });
      this.#updateLPFCutoffForPlaybackRate(playbackRate, timestamp, {
        glideTime: scaledGlideTime,
        // cancelPrevious: !!options.glide,
      });
    }

    // Only apply glide if pitch is enabled and glide is requested
    if (!this.#pitchDisabled && options.glide && scaledGlideTime > 0) {
      const rateParam = this.getParam('playbackRate')!;
      if (prevRate > 0) rateParam.setValueAtTime(prevRate, timestamp);

      this.getParam('playbackRate')!.setTargetAtTime(playbackRate, timestamp, scaledGlideTime);
    } else {
      this.setParam('playbackRate', playbackRate, timestamp);
    }

    this.setParam('velocity', velocity, timestamp);

    // Start playback
    this.sendToProcessor({
      type: 'voice:start',
      timestamp,
      triggerId: this.#triggerId,
    });
    this.#sendUpstreamMessage('voice:started', {
      voiceId: this.nodeId,
      midiNote: this.#midiNote,
    });

    // Trigger amp, filter and pitch envelopes if enabled
    // Same keytrack scale as the processor's loop range.
    const loopSeconds =
      this.#processedLoopSeconds * (1 + this.#idleLoopKeytrack * (Math.abs(playbackRate) - 1));
    this.#lastTrigger = { playbackRate, loopSeconds };
    this.triggerEnvelopes(timestamp, playbackRate);

    // Trigger effects
    this.#feedback?.trigger(soundingNote, {
      velocity,
      secondsFromNow,
      glideTime: scaledGlideTime,
      triggerDecay: true,
    });

    this.#am_lfo?.setMusicalNote(soundingNote + this.#am_lfo_semitone_offset, {
      divisor: 1,
      glideTime: scaledGlideTime,
      glideFromMidiNote: options.glide
        ? options.glide.prevMidiNote + this.#pitchOffset + this.#am_lfo_semitone_offset
        : undefined,
      timestamp,
    });

    return this.#midiNote;
  }

  /**
   * Trigger inputs of the current note, kept so a config edit can restart from them.
   * `loopSeconds` starts at the idle loop length and follows each sample loop cycle while held.
   */
  #lastTrigger: { playbackRate: number; loopSeconds: number } | null = null;

  #isEnvEnabled(envType: SampleEnvelopeId) {
    return this.#envelopeConfigs.get(envType)?.enabled ?? false;
  }

  #triggerEnvelope(
    envType: SampleEnvelopeId,
    env: Envelope,
    timestamp: number,
    playbackRate: number,
    fromPoint = 0,
  ) {
    assert(Number.isFinite(timestamp), 'SampleVoice envelope timestamp must be finite');
    if (!this.#isEnvEnabled(envType)) {
      this.#resetEnvTarget(envType, timestamp, envType === 'amp');
      return;
    }

    const config = this.#envelopeConfigs.get(envType)!;
    const resolved = resolveSampleEnvelopeTrigger(
      envType,
      config,
      playbackRate,
      this.#loopTimeScale(config, env),
    );
    env.trigger(timestamp, { ...resolved, fromPoint });
  }

  /** Fit the full buffer timeline to one audible sample loop; otherwise use ordinary timing. */
  #loopTimeScale(config: EnvelopeConfig, env: Envelope) {
    const trigger = this.#lastTrigger;
    if (!trigger || !config.loopSync || !this.#loopEnabled || env.shape.mode.type !== 'loop')
      return undefined;
    return trigger.loopSeconds > 0 && this.#sampleDurationSeconds > 0
      ? (this.#sampleDurationSeconds * Math.abs(trigger.playbackRate)) / trigger.loopSeconds
      : undefined;
  }

  triggerEnvelopes(timestamp: number, playbackRate: number) {
    this.#envelopes.forEach((env, envType) => {
      this.#triggerEnvelope(envType, env, timestamp, playbackRate);
    });

    const envDurations = Object.fromEntries(
      Array.from(this.#envelopes, ([envType, env]) => [envType, env.duration()]),
    );
    const loopEnabled = Object.fromEntries(
      Array.from(this.#envelopes, ([envType, env]) => [envType, env.shape.mode.type === 'loop']),
    );

    this.#sendUpstreamMessage('sample-envelopes:trigger', {
      voiceId: this.nodeId,
      midiNote: this.#midiNote,
      envDurations,
      loopEnabled,
    });
  }

  #releaseTimeout: number | null = null;
  #stopTimeout: number | null = null;

  #clearTimeouts() {
    if (this.#releaseTimeout !== null) {
      clearTimeout(this.#releaseTimeout);
      this.#releaseTimeout = null;
    }
    if (this.#stopTimeout !== null) {
      clearTimeout(this.#stopTimeout);
      this.#stopTimeout = null;
    }
  }

  #stopEnvelopes() {
    this.#envelopes.forEach((env) => env.stop());
  }

  #transitionTo(state: VoiceState, note?: { midiNote: number; startedTimestamp: number }) {
    switch (state) {
      case VoiceState.AVAILABLE:
        this.#clearTimeouts();
        this.#stopEnvelopes();
        this.#midiNote = null;
        break;

      case VoiceState.PLAYING:
        assert(this.#state === VoiceState.AVAILABLE, 'Only AVAILABLE voices can play');
        assert(note, 'PLAYING requires note information');
        this.#clearTimeouts();
        this.#triggerId++;
        this.#midiNote = note.midiNote;
        this.#startedTimestamp = note.startedTimestamp;
        break;

      case VoiceState.RELEASING:
        assert(this.#state === VoiceState.PLAYING, 'Only PLAYING voices can release');
        break;
    }

    this.#state = state;
  }

  /** Schedules envelope release; lifecycle messages report the scheduling-time state. */
  release({ secondsFromNow = 0 } = {}): this {
    if (this.#state !== VoiceState.PLAYING) return this;

    const envGain = this.getParam('envGain');
    if (!envGain) throw new Error('Cannot release - envGain parameter is null');

    this.#transitionTo(VoiceState.RELEASING);
    const timestamp = this.now + secondsFromNow;

    // Release all enabled envelopes
    this.#envelopes.forEach((env, envType) => {
      if (this.#isEnvEnabled(envType)) env.release(timestamp);
    });

    // A disabled amp env is a gate, so close it. ponytail: voice-side fade until #65 moves de-click fades into the processor.
    if (!this.#isEnvEnabled('amp')) envGain.setTargetAtTime(0, timestamp, AMP_GATE_SMOOTHING_SEC);

    this.sendToProcessor({ type: 'voice:release', timestamp });

    const releaseDuration = this.releaseTime;

    this.#sendUpstreamMessage('voice:releasing', {
      voiceId: this.nodeId,
      midiNote: this.#midiNote,
      releaseDuration,
    });

    // Stop after the scheduled release and amplitude tail.
    if (this.#releaseTimeout) clearTimeout(this.#releaseTimeout);
    this.#releaseTimeout = setTimeout(
      () => {
        try {
          if (this.#state !== VoiceState.AVAILABLE) {
            this.stop();
          }
        } finally {
          this.#releaseTimeout = null;
        }
      },
      (secondsFromNow + releaseDuration) * 1000 + 50,
    ); // 50ms buffer

    return this;
  }

  /**
   * The processor cuts output as soon as it gets `voice:stop`, so a stop is a
   * hard edge. De-click fading belongs on the processor side, where rendering
   * actually ends - see issue #65.
   */
  stop(timestamp = this.now): this {
    if (this.#state === VoiceState.AVAILABLE) return this;
    const midiNote = this.#midiNote;
    this.#transitionTo(VoiceState.AVAILABLE);
    this.#sendUpstreamMessage('voice:stopped', {
      voiceId: this.nodeId,
      midiNote,
    });

    const now = this.now;
    const stopAt = Math.max(timestamp, now);

    // Deferred even when stopAt is now, which lets a synchronous
    // stop()-then-trigger() coalesce into only voice:start.
    this.#stopTimeout = setTimeout(
      () => {
        // ponytail: the processor ignores this timestamp and stops on receipt,
        // so a future stopAt is only as accurate as the host timer. Sample
        // accuracy needs the processor to own stop timing - see issue #65.
        this.sendToProcessor({ type: 'voice:stop', timestamp: stopAt });
        this.#stopTimeout = null;
      },
      (stopAt - now) * 1000,
    );
    return this;
  }

  /**  Set HPF cutoff relative to playback rate */
  #updateHPFCutoffForPlaybackRate(
    playbackRate: number,
    atTime: number = this.now,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ) {
    if (this.#midiNote === null || !this.#hpf || this.#keytrackHPFAmount <= 0) {
      return;
    }

    const freq = this.#hpf.frequency;
    const { glideTime = 0, cancelPrevious = true } = options || {};
    if (cancelPrevious) {
      freq.cancelScheduledValues(atTime);
    }

    const keytrackedHz = getKeytrackedFilterHz(this.#hpfHz, playbackRate, this.#keytrackHPFAmount);
    const safeHz = clampHz(keytrackedHz, this.context.sampleRate);

    const timeConstant = durationToTimeConstant(glideTime, DEFAULT.CUTOFF_SMOOTHING_SEC);
    freq.setTargetAtTime(safeHz, atTime, timeConstant);
  }

  /**  Set LPF cutoff relative to playback rate */
  #updateLPFCutoffForPlaybackRate(
    playbackRate: number,
    atTime: number = this.now,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ) {
    if (this.#midiNote === null || !this.#lpf || this.#keytrackLPFAmount <= 0) {
      return;
    }

    const freq = this.#lpf.frequency;
    const { glideTime = 0, cancelPrevious = true } = options || {};
    if (cancelPrevious) {
      freq.cancelScheduledValues(atTime);
    }

    const keytrackedHz = getKeytrackedFilterHz(this.#lpfHz, playbackRate, this.#keytrackLPFAmount);
    const safeHz = clampHz(keytrackedHz, this.context.sampleRate);

    const timeConstant = durationToTimeConstant(glideTime, DEFAULT.CUTOFF_SMOOTHING_SEC);
    freq.setTargetAtTime(safeHz, atTime, timeConstant);
  }

  // === LFOs ===

  /** Cleanup amplitude modulation LFO */
  #cleanupAmpModLFO() {
    if (!this.#am_lfo) return;
    this.#am_lfo.dispose();
    this.#am_lfo = null;
    return this;
  }

  /** @deprecated Use setModulationDepth. */
  setModulationAmount(modType: 'AM' | 'FM', depth: number) {
    return this.setModulationDepth(modType, depth);
  }

  setModulationDepth(modType: 'AM' | 'FM', depth: number) {
    if (modType === 'AM' && !this.#chainIncludes('am')) return this;

    const safeDepth = mapToRange(depth, 0, 1, 0, 0.95, {
      warn: true,
      name: 'sampleVoice.setModulationDepth',
    });

    if (modType === 'AM') {
      this.#am_lfo?.setDepth(safeDepth);
    } else if (modType === 'FM') {
      console.warn('SampleVoice: FM modulation not implemented yet');
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
      console.info('SampleVoice: FM modulation not implemented yet');
    }
    return this;
  }

  // === ENVELOPES ===

  /** Moves a param to where it rests while its envelope is off. */
  #resetEnvTarget = (envType: SampleEnvelopeId, time = this.now, smooth = true) => {
    const param = this.getParam(getSampleEnvelopeParamName(envType));
    const smoothing = envType === 'amp' ? AMP_GATE_SMOOTHING_SEC : DEFAULT.CUTOFF_SMOOTHING_SEC;
    param?.cancelScheduledValues(time);
    const value = getSampleEnvelopeRestValue(envType);
    if (smooth) param?.setTargetAtTime(value, time, smoothing);
    else param?.setValueAtTime(value, time);
  };

  /**
   * Receives the config owned by SamplePlayer. The sampler policy chooses when to
   * retrigger; Envelope keeps the active run separate from its stored shape.
   */
  setEnvelopeConfig = (envType: SampleEnvelopeId, config: EnvelopeConfig) => {
    const envelope = this.#envelopes.get(envType);
    if (!envelope) return;
    const wasEnabled = this.#isEnvEnabled(envType);
    // Read the current run before replacing its stored shape.
    const fromPoint =
      config.shape.mode.type === 'loop' && envelope.shape.mode.type !== 'loop'
        ? envelope.currentPoint()
        : null;
    const retriggerAt = fromPoint !== null ? this.now : envelope.nextCycleTime();

    this.#envelopeConfigs.set(envType, config);
    envelope.shape = config.shape;
    if (config.shape.mode.type === 'sustain') {
      envelope.setSustainValue(config.shape.points[config.shape.sustainPoint].value);
    }

    if (wasEnabled && !config.enabled) {
      // Keep an already scheduled amp release; switching it off must not reopen the gate.
      if (envType === 'amp' && this.#state === VoiceState.RELEASING) return;
      envelope.stop();
      this.#resetEnvTarget(envType);
      return;
    }

    if (retriggerAt !== null && this.#lastTrigger) {
      this.#triggerEnvelope(
        envType,
        envelope,
        retriggerAt,
        this.#lastTrigger.playbackRate,
        fromPoint ?? 0,
      );
    }
  };

  #onLoopCycleStart(processedSeconds: number, timestamp: number) {
    const trigger = this.#lastTrigger;
    if (!trigger || !(processedSeconds > 0)) return;

    trigger.loopSeconds = processedSeconds;

    // Re-trigger loop-synced envelopes at the sample loop cycle boundary
    this.#retriggerLoopingEnvelopes(timestamp, trigger.playbackRate);
  }

  #retriggerLoopingEnvelopes(timestamp: number, playbackRate: number) {
    if (this.#state === VoiceState.RELEASING || !this.#loopEnabled) return;

    this.#envelopes.forEach((env, envType) => {
      if (env.shape.mode.type !== 'loop') return;
      if (!this.#envelopeConfigs.get(envType)?.loopSync) return;
      this.#triggerEnvelope(envType, env, timestamp, playbackRate);
    });
  }

  get envelopes() {
    return this.#envelopes;
  }

  setParam(
    name: string,
    targetValue: number,
    timestamp: number = this.now,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ): this {
    const param = this.getParam(name);
    if (!param) return this;

    const { glideTime = 0, cancelPrevious = true } = options;

    if (glideTime <= 0) {
      if (cancelPrevious) param.cancelScheduledValues(timestamp);
      param.setValueAtTime(targetValue, Math.max(timestamp, this.now + 0.001));
    } else {
      // param.value is only valid now: a future glide falls back to a plain cancel.
      if (cancelPrevious) {
        if (timestamp <= this.now) cancelAndPinParamValue(param, timestamp);
        else param.cancelScheduledValues(timestamp);
      }
      param.linearRampToValueAtTime(targetValue, timestamp + Math.max(glideTime, 0.001));
    }

    return this;
  }

  /** Both points at one event time: re-reading `now` per param can split them across frames. */
  setLoopPoints(loopStart: number, loopEnd: number, timestamp: number = this.now): this {
    const startParam = this.getParam('loopStart');
    const endParam = this.getParam('loopEnd');
    if (!startParam || !endParam) return this;
    const at = Math.max(timestamp, this.now + 0.001);
    startParam.cancelScheduledValues(timestamp);
    endParam.cancelScheduledValues(timestamp);
    startParam.setValueAtTime(loopStart, at);
    endParam.setValueAtTime(loopEnd, at);
    return this;
  }

  protected setParams(
    paramsAndValues: Array<{ name: string; value: number }>,
    atTime: number,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ): this {
    const validParams = paramsAndValues.filter((pv) => this.getParam(pv.name) !== null);
    if (validParams.length === 0) return this;

    validParams.forEach(({ name, value }) => {
      // Pass the absolute timestamp to ensure all parameters use the same timestamp
      this.setParam(name, value, atTime, { ...options });
    });
    return this;
  }

  syncLoopToTempo(enabled: boolean) {
    this.sendToProcessor({
      type: 'syncLoopToTempo',
      value: enabled,
    });
    return this;
  }

  setLoopRampDuration(seconds: number) {
    this.sendToProcessor({ type: 'setLoopRampDuration', value: seconds });
    return this;
  }

  setKeytrackLoopAmount(amount: number) {
    this.sendToProcessor({
      type: 'setKeytrackLoopAmount',
      value: amount,
    });
    return this;
  }

  setTempo(bpm: number) {
    this.setParam('tempo', bpm, this.now);
    return this;
  }

  disablePitch = () => {
    this.#pitchDisabled = true;
    const timestamp = this.now;
    const glideTime = 0.1;

    this.getParam('playbackRate')?.linearRampToValueAtTime(1, timestamp + glideTime);

    this.#updateHPFCutoffForPlaybackRate(1, timestamp, { glideTime });
    this.#updateLPFCutoffForPlaybackRate(1, timestamp, { glideTime });
  };

  enablePitch = () => {
    this.#pitchDisabled = false;
    const timestamp = this.now;
    const glideTime = 0.1;

    if (this.#midiNote !== null) {
      const rate = midiToPlaybackRate(this.#midiNote + this.#pitchOffset);
      this.getParam('playbackRate')?.linearRampToValueAtTime(rate, this.context.currentTime + 0.01);
      this.#updateHPFCutoffForPlaybackRate(rate, timestamp, {
        glideTime,
      });
      this.#updateLPFCutoffForPlaybackRate(rate, timestamp, {
        glideTime,
      });
    }
  };

  /** CONNECTIONS */

  connect(destination: Destination, output?: number, input?: number): Destination {
    if (destination instanceof LibAudioNode) {
      this.out.connect(destination.input, output);
    } else if (destination instanceof AudioParam) {
      this.out.connect(destination, output);
    } else if (destination instanceof AudioNode) {
      this.out.connect(destination, output, input);
    } else {
      console.warn('SampleVoice: Unsupported destination', destination);
    }
    return destination;
  }

  disconnect(output = 'main', destination?: Destination): this {
    if (output === 'alt') {
      console.warn(`SampleVoice has no "alt" output to disconnect`);
      return this;
    }
    if (!destination) {
      this.out.disconnect();
    } else if (destination instanceof AudioNode) {
      this.out.disconnect(destination);
    } else if (destination instanceof AudioParam) {
      this.out.disconnect(destination);
    }
    return this;
  }

  /** MESSAGES */

  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  sendToProcessor(data: any): this {
    this.#playerWorklet.port.postMessage(data);
    return this;
  }

  #sendUpstreamMessage(type: string, data: any) {
    this.#messages.sendMessage(type, data);
    return this;
  }

  #setupWorkletMessageHandling() {
    this.#playerWorklet.port.onmessage = (event: MessageEvent) => {
      let { type, ...data } = event.data;

      switch (type) {
        case 'initialized':
          this.#isInitialized = true;

          this.#sendUpstreamMessage('voice:initialized', {
            voiceId: this.nodeId,
          });
          break;

        case 'voice:loaded':
          if (data.durationSeconds) {
            this.#sampleDurationSeconds = data.durationSeconds;
            this.#processedLoopSeconds = 0;
            this.#createEnvelopes(); // Todo: move to init and only update env duration IF needed
          }
          break;

        case 'voice:ended': {
          if (this.#state === VoiceState.AVAILABLE || data.triggerId !== this.#triggerId) {
            return;
          }
          const midiNote = this.#midiNote;
          this.#transitionTo(VoiceState.AVAILABLE);
          type = 'voice:stopped';
          data = {
            voiceId: this.nodeId,
            midiNote,
          };
          break;
        }

        case 'loop:range':
        case 'loop:cycle':
        case 'trim:range':
        case 'voice:position': {
          // Idle report: the steady loop length for the next note. Not a playing range.
          if (data.idle) {
            this.#processedLoopSeconds = data.loopEnd - data.loopStart;
            this.#idleLoopKeytrack = data.keytrackAmount ?? 0;
            return;
          }
          if (this.#state === VoiceState.AVAILABLE || data.triggerId !== this.#triggerId) {
            return;
          }
          const { triggerId: _, ...range } = data;
          data = { voiceId: this.nodeId, midiNote: this.#midiNote, ...range };
          if (type === 'loop:cycle') {
            this.#onLoopCycleStart(data.loopSeconds, data.time);
          } else if (type === 'voice:position') {
            this.getParam('playbackPosition')?.setValueAtTime(
              data.position,
              this.context.currentTime,
            );
          }
          break;
        }

        // Forwarded upstream by the tail call, nothing to do here.
        case 'loop:enabled':
        case 'loop:syncToTempo':
        case 'voice:reset':
        case 'voice:playbackDirectionChange':
          break;

        default:
          console.warn(`Unhandled message type: ${type}`);
          break;
      }

      this.#sendUpstreamMessage(type, data);
    };
  }

  // Getters

  getPlaybackDuration() {
    const startPoint = this.getParam('startPoint')!.value;
    const endPoint = this.getParam('endPoint')!.value;
    return Math.abs(endPoint - startPoint);
  }

  get feedback() {
    return this.#feedback;
  }

  get hpf() {
    return this.#hpf;
  }

  get lpf() {
    return this.#lpf;
  }

  get in() {
    return null;
  }

  get out() {
    return this.#outputNode;
  }

  get state(): VoiceState {
    return this.#state;
  }

  get initialized() {
    return this.#isInitialized;
  }

  get now(): number {
    return this.context.currentTime;
  }

  get midiNote(): number | null {
    return this.#midiNote;
  }

  get triggerTimestamp(): number {
    return this.#startedTimestamp;
  }

  get sampleDurationSeconds() {
    return this.#sampleDurationSeconds;
  }

  get startPoint() {
    return this.getParam('startPoint')!.value;
  }

  get endPoint() {
    return this.getParam('endPoint')!.value;
  }

  /** Amp release duration, or the gate fade while the amp envelope is off; drives voice cleanup. */
  get releaseTime() {
    // ~5 time constants is under 1% of the gate level.
    if (!this.#isEnvEnabled('amp')) return AMP_GATE_SMOOTHING_SEC * 5;
    return this.#envelopes.get('amp')!.releaseDuration();
  }

  // Setters

  enablePositionTracking(enabled: boolean) {
    this.sendToProcessor({
      type: 'voice:usePlaybackPosition',
      value: enabled,
    });

    return this;
  }

  setLoopEnabled(enabled: boolean): this {
    this.#loopEnabled = enabled; // a trigger right after must see it, not wait for the reply
    this.sendToProcessor({
      type: 'setLoopEnabled',
      value: enabled,
    });

    return this;
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
    atTime: number = this.now,
    options: { glideTime?: number; cancelPrevious?: boolean } = {},
  ) {
    if (!this.#chainIncludes('hpf')) return this;

    const safeHz = clampHz(hz, this.context.sampleRate);
    this.#hpfHz = safeHz;
    if (this.#hpf) {
      const timeConstant = durationToTimeConstant(options.glideTime, DEFAULT.CUTOFF_SMOOTHING_SEC);
      if (options.cancelPrevious ?? true) this.#hpf.frequency.cancelScheduledValues(atTime);
      this.#hpf.frequency.setTargetAtTime(safeHz, atTime, timeConstant);
      const currentRate = this.getParam('playbackRate')?.value ?? 1;
      this.#updateHPFCutoffForPlaybackRate(currentRate, atTime, options);
    }
    return this;
  }

  /**
   * @param options.glideTime Ramp duration in seconds. For the filter cutoffs this is
   * converted to a `setTargetAtTime` time constant (glideTime / 3), so the cutoff is
   * ~95% settled at `glideTime`. When omitted, DEFAULT.CUTOFF_SMOOTHING_SEC is used as
   * the time constant itself, so the cutoff is ~95% settled after 3x that.
   * @param options.cancelPrevious Clear automation already scheduled on the param.
   * Defaults to true. Pass false to let a running envelope or LFO ramp survive.
   */
  setLpfCutoff(
    hz: number,
    atTime: number = this.now,
    options: { glideTime?: number; cancelPrevious?: boolean } = {},
  ) {
    if (!this.#chainIncludes('lpf')) return this;

    const safeHz = clampHz(hz, this.context.sampleRate);
    this.#lpfHz = safeHz;
    if (this.#lpf) {
      const timeConstant = durationToTimeConstant(options.glideTime, DEFAULT.CUTOFF_SMOOTHING_SEC);
      if (options.cancelPrevious ?? true) this.#lpf.frequency.cancelScheduledValues(atTime);
      this.#lpf.frequency.setTargetAtTime(safeHz, atTime, timeConstant);
      const currentRate = this.getParam('playbackRate')?.value ?? 1;
      this.#updateLPFCutoffForPlaybackRate(currentRate, atTime, options);
    }
    return this;
  }

  setPlaybackDirection(direction: 'forward' | 'reverse'): this {
    this.sendToProcessor({
      type: 'voice:setPlaybackDirection',
      playbackDirection: direction,
    });

    return this;
  }

  /** Enables turns at both loop edges; disabling restores the mode set by loop point order. */
  setLoopPingPong(enabled: boolean): this {
    this.sendToProcessor({ type: 'setLoopPingPong', value: enabled });
    return this;
  }

  setLoopDurationDriftAmount(amount: number): this {
    this.setParam('loopDurationDriftAmount', amount, this.now);
    return this;
  }

  setPanDriftEnabled = (enabled: boolean) =>
    this.sendToProcessor({ type: 'setPanDriftEnabled', value: enabled });

  setTimestretchMode = (mode: TimestretchMode) =>
    this.sendToProcessor({ type: 'setTimestretchMode', value: mode });

  setAMModOctaveOffset(offset: number) {
    assert(
      offset >= samplerParams.amModOctaveOffset.min &&
        offset <= samplerParams.amModOctaveOffset.max,
      `AM modulation octave offset must be between ${samplerParams.amModOctaveOffset.min} and ${samplerParams.amModOctaveOffset.max}`,
    );
    const semitoneOffset = offset * 12; // convert octaves to semitones
    this.#am_lfo_semitone_offset = semitoneOffset;
    if (this.#am_lfo && this.#midiNote !== null) {
      this.#am_lfo.setMusicalNote(this.#midiNote + this.#pitchOffset + semitoneOffset);
    }
  }

  debugDuration() {
    console.info(`
      sample duration: ${this.sampleDurationSeconds}, 
      startPoint: ${this.getParam('startPoint')!.value},
      endPoint: ${this.getParam('endPoint')!.value},
      playback duration: ${this.getPlaybackDuration()}
      `);
  }

  dispose(): void {
    this.stop();
    this.disconnect();
    this.#cleanupAmpModLFO();
    this.#envelopes.forEach((env) => env.stop());
    this.#playerWorklet.port.close();
    this.#clearTimeouts();
    unregisterNode(this.nodeId);
  }

  getParam(name: string): AudioParam | null {
    if (this.#playerWorklet && this.#playerWorklet.parameters.has(name)) {
      return this.#playerWorklet.parameters.get(name) ?? null;
    }

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
      case 'lpfDetune':
        return this.#lpf?.detune ?? null;
      default:
        return null;
    }
  }
}
