import { LibAudioNode, Destination, NodeType } from '@/nodes';
import { DEFAULT } from '@/constants';
import { registerNode, NodeID, unregisterNode } from '@/nodes/node-store';
import { VoiceState } from '../VoiceState';

import { Message, MessageHandler, createMessageBus, MessageBus } from '@/events';

import { assert, mapToRange, midiToPlaybackRate } from '@/utils';
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
import type { PitchPeriods } from '@/utils/audiodata/pitchDetection/pitchPeriods';
import {
  createDefaultSampleEnvelopeConfig,
  getSampleEnvelopeRestValue,
  getSampleEnvelopeIds,
  getSampleEnvelopeParamName,
  getSampleEnvelopeProcessorTarget,
  resolveSampleEnvelopeForProcessor,
  resolveSampleEnvelopeTrigger,
  type SampleEnvelopeId,
} from './sample-envelope-policy';

export type SampleVoiceChainNode = 'feedback' | 'am' | 'hpf' | 'lpf';
export type TimestretchMode = 'off' | 'period';
/** Experimental: for comparing source interpolation by ear, may be removed. */
export type InterpolationMode = 'linear' | 'hermite' | 'sinc';

const DEFAULT_CHAIN_ORDER: readonly SampleVoiceChainNode[] = ['am', 'hpf', 'feedback', 'lpf'];

/** Time constant for envGain returning to rest when the amp envelope is disabled mid-note. */
const AMP_GATE_SMOOTHING_SEC = 0.002;

export class SampleVoice {
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
  /** Experimental: the processor plays envelopes it has a target for, instead of `#envelopes`. */
  #audioThreadEnvelopes = false;

  #state: VoiceState = VoiceState.AVAILABLE;
  #isInitialized = false;

  // Set once `voice:setBuffer` is on the wire rather than on the processor's
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
  /** Loop keytrack in effect for the idle length, which is resolved at playback rate 1. */
  #idleLoopKeytrack = 0;

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
      numberOfOutputs: 2,
      // Stereo audio, plus the audio-thread filter envelope in cents for lpf.detune
      outputChannelCount: [2, 1],
      processorOptions: options.processorOptions || {},
    });

    // Connections are made in #connectAudioChain() during init()
  }

  async init(): Promise<void> {
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = (async () => {
      try {
        // Create nodes
        this.#initInternalSignalChainNodes();

        // Connect nodes
        this.#connectAudioChain();

        // Create envelopes
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
    // Sums with lpf.detune's own value, so it stays 0 while the filter envelope is off.
    if (this.#lpf) this.#playerWorklet.connect(this.#lpf.detune, 1);
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
      const paramName = getSampleEnvelopeParamName(type);
      // ponytail: audio-thread-only envelopes keep just a config, inactive with the flag off.
      if (paramName === null) {
        this.#envelopeConfigs.set(type, config);
        continue;
      }
      const param = this.getParam(paramName);
      if (!param) continue;
      this.#envelopes.set(type, new Envelope(this.context, param, config.shape));
      this.#envelopeConfigs.set(type, config);
    }
    this.#sendProcessorEnvelopes();
  }

  async loadBuffer(buffer: AudioBuffer, zeroCrossings?: number[]): Promise<boolean> {
    if (buffer.sampleRate !== this.context.sampleRate) {
      console.warn(
        `Sample rate mismatch - buffer: ${buffer.sampleRate}, context: ${this.context.sampleRate}`,
      );
      return false;
    }
    // postMessage structured-clones each channel, so no local copy needed.
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
      buffer.getChannelData(i),
    );

    // The processor drops isPlaying when it swaps audio data and never echoes a
    // stop for it, so end the note here or the voice stays PLAYING in silence.
    this.stop();

    this.sendToProcessor({
      type: 'voice:setBuffer',
      buffer: channels,
      durationSeconds: buffer.duration,
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

  /** Retunes a held note too: playback rate, feedback and the AM LFO follow. */
  setPitchOffset(semitones: number): this {
    if (this.#pitchOffset === semitones) return this;
    this.#pitchOffset = semitones;
    if (this.#midiNote !== null) this.#applyPitch(this.#midiNote, this.now, 0.01);
    return this;
  }

  /** Keeps the source, velocity and envelopes running; note-off follows the new note. */
  retune(midiNote: MidiValue, secondsFromNow = 0, glideTime = 0): MidiValue | null {
    if (this.#state !== VoiceState.PLAYING) return null;
    this.#applyPitch(midiNote, this.now + secondsFromNow, glideTime);
    return midiNote;
  }

  /** Moves a sounding note: playback rate, feedback and the AM LFO follow. */
  #applyPitch(midiNote: MidiValue, timestamp: number, glideSeconds: number) {
    const soundingNote = midiNote + this.#pitchOffset;
    const playbackRate = this.#pitchDisabled ? 1 : midiToPlaybackRate(soundingNote);
    if (!this.#pitchDisabled && glideSeconds > 0) {
      const param = this.getParam('playbackRate')!;
      if (timestamp <= this.now) cancelAndPinParamValue(param, timestamp);
      else param.cancelScheduledValues(timestamp);
      param.setTargetAtTime(playbackRate, timestamp, glideSeconds);
    } else {
      this.setParam('playbackRate', playbackRate, timestamp);
    }
    this.#feedback?.setPitch(soundingNote, 0, timestamp, glideSeconds);
    this.#am_lfo?.setMusicalNote(soundingNote + this.#am_lfo_semitone_offset, {
      timestamp,
      glideTime: glideSeconds,
    });
    this.#midiNote = midiNote;
    if (this.#lastTrigger) this.#lastTrigger.playbackRate = playbackRate;
  }

  #isInPitchLoop = false;

  /** Latest processor report, gated by the current voice and loop state. */
  get isInPitchLoop(): boolean {
    return this.#state === VoiceState.PLAYING && this.#loopEnabled && this.#isInPitchLoop;
  }

  trigger(options: {
    midiNote: MidiValue;
    velocity: MidiValue;
    secondsFromNow?: number;
    glide?: { fromMidiNote: number; seconds: number };
  }): MidiValue | null {
    if (!this.#hasLoadedAudio) return null;
    const { midiNote, velocity, secondsFromNow = 0 } = options;
    const timestamp = this.now + secondsFromNow;

    if (this.#state !== VoiceState.AVAILABLE) {
      console.log(`had to stop a playing voice, midinote: ${midiNote}`);
      this.stop(timestamp);
      return null;
    }

    this.#transitionTo(VoiceState.PLAYING, {
      midiNote,
      startedTimestamp: timestamp,
    });

    const glideSeconds = options.glide?.seconds ?? 0;
    const glideFrom = glideSeconds > 0 ? options.glide!.fromMidiNote + this.#pitchOffset : null;
    const soundingNote = midiNote + this.#pitchOffset;
    const playbackRate = this.#pitchDisabled ? 1 : midiToPlaybackRate(soundingNote);

    if (!this.#pitchDisabled && glideFrom !== null) {
      const rateParam = this.getParam('playbackRate')!;
      rateParam.setValueAtTime(midiToPlaybackRate(glideFrom), timestamp);
      rateParam.setTargetAtTime(playbackRate, timestamp, glideSeconds);
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

    // Todo: On initial trigger, if loop does not start at right away, we should defer scaling envelopes to the loop until entering the loop range, or until the processor reports the first wrap or turn
    // TODO: This initial estimate omits period-stretch inversion, so loop-synced
    // envelopes can start at the wrong speed until the first loop-cycle report.
    // Moving envelopes to the audio thread will remove the need for this estimate.
    const loopSeconds =
      this.#processedLoopSeconds * Math.abs(playbackRate) ** this.#idleLoopKeytrack;
    this.#lastTrigger = { playbackRate, loopSeconds };
    this.triggerEnvelopes(timestamp, playbackRate);

    // Trigger effects
    this.#feedback?.trigger(soundingNote, {
      velocity,
      secondsFromNow,
      glideTime: glideSeconds,
      triggerDecay: true,
    });

    this.#am_lfo?.setMusicalNote(soundingNote + this.#am_lfo_semitone_offset, {
      divisor: 1,
      glideTime: glideSeconds,
      glideFromMidiNote: glideFrom === null ? undefined : glideFrom + this.#am_lfo_semitone_offset,
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
    catchUp = false,
  ) {
    assert(Number.isFinite(timestamp), 'SampleVoice envelope timestamp must be finite');
    if (!this.#isEnvEnabled(envType)) {
      this.#resetEnvTarget(envType, timestamp, false);
      return;
    }

    // The processor triggers its own envelopes on voice:start.
    if (this.#onAudioThread(envType)) return;

    const config = this.#envelopeConfigs.get(envType)!;
    const resolved = resolveSampleEnvelopeTrigger(
      envType,
      config,
      playbackRate,
      this.#loopTimeScale(config, env),
    );

    env.trigger(timestamp, { ...resolved, fromPoint, catchUp });
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
  }

  #stopEnvelopes() {
    this.#envelopes.forEach((env) => env.stop());
  }

  #transitionTo(state: VoiceState, note?: { midiNote: number; startedTimestamp: number }) {
    switch (state) {
      case VoiceState.AVAILABLE:
        this.#stopEnvelopes();
        this.#midiNote = null;
        break;

      case VoiceState.PLAYING:
        assert(this.#state === VoiceState.AVAILABLE, 'Only AVAILABLE voices can play');
        assert(note, 'PLAYING requires note information');
        this.#triggerId++;
        this.#isInPitchLoop = false;
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

    this.#transitionTo(VoiceState.RELEASING);
    const timestamp = this.now + secondsFromNow;

    // Release all enabled envelopes
    this.#envelopes.forEach((env, envType) => {
      if (this.#isEnvEnabled(envType) && !this.#onAudioThread(envType)) env.release(timestamp);
    });

    const releaseDuration = this.releaseTime;

    this.#sendUpstreamMessage('voice:releasing', {
      voiceId: this.nodeId,
      midiNote: this.#midiNote,
      releaseDuration,
    });

    // The processor stops at the end of the amp tail and reports it as voice:ended.
    if (this.#onAudioThread('amp') && this.#isEnvEnabled('amp')) {
      this.sendToProcessor({ type: 'voice:release', timestamp });
    } else {
      this.sendToProcessor({ type: 'voice:stop', timestamp: timestamp + releaseDuration });
    }
    return this;
  }

  /**
   * The processor schedules the stop on its render clock and fades out from
   * `timestamp`; a `voice:start` that follows supersedes it.
   */
  stop(timestamp = this.now): this {
    if (this.#state === VoiceState.AVAILABLE) return this;
    const midiNote = this.#midiNote;
    this.#transitionTo(VoiceState.AVAILABLE);
    this.#sendUpstreamMessage('voice:stopped', {
      voiceId: this.nodeId,
      midiNote,
    });
    this.sendToProcessor({ type: 'voice:stop', timestamp });
    return this;
  }

  // === LFOs ===

  /** Cleanup amplitude modulation LFO */
  #cleanupAmpModLFO() {
    if (!this.#am_lfo) return;
    this.#am_lfo.dispose();
    this.#am_lfo = null;
    return this;
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
    const paramName = getSampleEnvelopeParamName(envType);
    const param = paramName === null ? null : this.getParam(paramName);
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
    if (!envelope) {
      if (!this.#envelopeConfigs.has(envType)) return;
      this.#envelopeConfigs.set(envType, config);
      return this.#sendProcessorEnvelope(envType);
    }
    const wasEnabled = this.#isEnvEnabled(envType);
    // Read the current run before replacing its stored shape.
    const fromPoint =
      config.shape.mode.type === 'loop' && envelope.shape.mode.type !== 'loop'
        ? envelope.currentPoint()
        : null;
    const retriggerAt = fromPoint !== null ? this.now : envelope.nextCycleTime();

    this.#envelopeConfigs.set(envType, config);
    envelope.shape = config.shape;
    // ponytail: the processor applies a new shape at its next point; live-edit rules are undecided.
    if (this.#onAudioThread(envType)) return this.#sendProcessorEnvelope(envType);
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
      if (!this.#isEnvEnabled(envType) || env.shape.mode.type !== 'loop') return;
      if (!this.#envelopeConfigs.get(envType)?.loopSync || this.#onAudioThread(envType)) return;
      this.#triggerEnvelope(envType, env, timestamp, playbackRate, 0, true);
    });
  }

  get envelopes() {
    return this.#envelopes;
  }

  /** Every envelope this voice takes configs for, including audio-thread-only ones. */
  get envelopeIds(): SampleEnvelopeId[] {
    return [...this.#envelopeConfigs.keys()];
  }

  /**
   * Experimental: plays the amp, pitch, pan and filter envelopes on the audio thread,
   * sample-accurate and restarting on the processor's own loop wraps under loopSync.
   * Takes effect from the next note.
   */
  setAudioThreadEnvelopes(enabled: boolean): this {
    if (this.#audioThreadEnvelopes === enabled) return this;
    this.#audioThreadEnvelopes = enabled;
    this.#envelopes.forEach((env, envType) => {
      if (!getSampleEnvelopeProcessorTarget(envType)) return;
      env.stop();
      this.#resetEnvTarget(envType);
    });
    this.#sendProcessorEnvelopes();
    return this;
  }

  #onAudioThread(envType: SampleEnvelopeId) {
    return this.#audioThreadEnvelopes && getSampleEnvelopeProcessorTarget(envType) !== null;
  }

  #sendProcessorEnvelopes() {
    this.#envelopeConfigs.forEach((_, envType) => this.#sendProcessorEnvelope(envType));
  }

  #sendProcessorEnvelope(envType: SampleEnvelopeId) {
    const target = getSampleEnvelopeProcessorTarget(envType);
    if (!target) return;
    const config = this.#envelopeConfigs.get(envType);
    const value =
      this.#audioThreadEnvelopes && config?.enabled
        ? resolveSampleEnvelopeForProcessor(envType, config)
        : null;
    this.sendToProcessor({ type: 'setEnvelope', target, value });
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

  setLoopLengthGlide(seconds: number): this {
    this.sendToProcessor({ type: 'setLoopLengthGlide', value: seconds });
    return this;
  }

  setLoopPositionGlide(seconds: number): this {
    this.sendToProcessor({ type: 'setLoopPositionGlide', value: seconds });
    return this;
  }

  setKeytrackLoopAmount(amount: number) {
    this.sendToProcessor({
      type: 'setKeytrackLoopAmount',
      value: amount,
    });
    return this;
  }

  disablePitch = () => {
    this.#pitchDisabled = true;
    const timestamp = this.now;
    const glideTime = 0.1;

    this.getParam('playbackRate')?.linearRampToValueAtTime(1, timestamp + glideTime);
  };

  enablePitch = () => {
    this.#pitchDisabled = false;
    if (this.#midiNote !== null) {
      const playbackRate = midiToPlaybackRate(this.#midiNote + this.#pitchOffset);
      this.getParam('playbackRate')?.linearRampToValueAtTime(
        playbackRate,
        this.context.currentTime + 0.01,
      );
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
          if (type === 'loop:range') this.#isInPitchLoop = data.isInPitchLoop ?? false;
          if (type === 'loop:cycle') {
            this.#onLoopCycleStart(data.loopSeconds, data.time);
            return;
          }
          const { triggerId: _, ...range } = data;
          data = { voiceId: this.nodeId, midiNote: this.#midiNote, ...range };
          break;
        }

        // Forwarded upstream by the tail call, nothing to do here.
        case 'loop:enabled':
          break;

        default:
          console.warn(`Unhandled message type: ${type}`);
          break;
      }

      this.#sendUpstreamMessage(type, data);
    };
  }

  // Getters

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

  /** Amp release duration, or 0 while the amp envelope is off; drives voice cleanup. */
  get releaseTime() {
    if (!this.#isEnvEnabled('amp')) return 0;
    return this.#envelopes.get('amp')!.releaseDuration();
  }

  // Setters

  enablePositionTracking(enabled: boolean) {
    this.sendToProcessor({
      type: 'voice:reportPlaybackPosition',
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

  setInterpolation = (mode: InterpolationMode) =>
    this.sendToProcessor({ type: 'setInterpolation', value: mode });

  setPitchPeriods = ({ periods, hopSamples }: PitchPeriods) =>
    this.sendToProcessor({ type: 'voice:setPitchPeriods', periods, hopSamples });

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

  dispose(): void {
    this.stop();
    this.disconnect();
    this.#cleanupAmpModLFO();
    this.#envelopes.forEach((env) => env.stop());
    this.#playerWorklet.port.close();
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
