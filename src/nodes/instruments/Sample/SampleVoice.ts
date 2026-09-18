import { LibAudioNode, Destination, NodeType } from '@/nodes';
import { getAudioContext } from '@/context';
import { DEFAULT } from '@/constants';
import { registerNode, NodeID, unregisterNode } from '@/nodes/node-store';
import { VoiceState } from '../VoiceState';

import { Message, MessageHandler, createMessageBus, MessageBus } from '@/events';

import {
  assert,
  interpolateLinearToGeometric,
  mapToRange,
  midiToPlaybackRate,
  getKeytrackedFilterHz,
  clampHz,
  durationToTimeConstant,
  maxSafeHz,
} from '@/utils';

import { EnvelopeRuntime, type EnvelopeSettings } from '@/nodes/params/envelopes';

import { HarmonicFeedback } from '@/nodes/effects/HarmonicFeedback';

import { LFO } from '@/nodes/params/LFOs/LFO';
import { CustomLibWaveform, WaveformOptions } from '@/utils/audiodata/generate/generateWaveform';
import { samplerParams } from './sampler-params';
import {
  applyOnNextEnvLoopCycle,
  createDefaultSampleEnvelopeSettings,
  getSampleEnvelopeBaseValue,
  getSampleEnvelopeIds,
  getSampleEnvelopeParamName,
  resolveSampleEnvelopeTrigger,
  shouldTriggerSampleEnvelope,
  type SampleEnvelopeId,
} from './temporary-sample-envelope-adapters';

export type SampleVoiceChainNode = 'feedback' | 'am' | 'hpf' | 'lpf';

const DEFAULT_CHAIN_ORDER: readonly SampleVoiceChainNode[] = ['am', 'hpf', 'feedback', 'lpf'];

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

  #envelopes = new Map<SampleEnvelopeId, EnvelopeRuntime>();
  #playbackRateSyncedEnvelopes = new Set<SampleEnvelopeId>();

  #state: VoiceState = VoiceState.AVAILABLE;
  #isInitialized = false;

  // Set once `voice:setLayers` is on the wire rather than on the processor's
  // `voice:loaded` ack: the port preserves order, so a `voice:start` posted in
  // the round trip still arrives after the layers are in place.
  #hasLoadedAudio = false;

  #midiNote: number | null = null;
  #startedTimestamp: number = -1;
  #triggerId = 0;

  #sampleDurationSeconds = 0;

  #pitchGlideTime = 0; // in seconds

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
    private context: AudioContext = getAudioContext(),
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

        // ? Why is this necessary ?
        // Initialize loopEnd to 0 to force the macro parameter to update
        // This ensures the macro's value will be applied when connected
        this.setParam('loopStart', 0, this.now);
        this.setParam('loopEnd', 0, this.now);

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
      this.#am_lfo.setWaveform('square');
      this.#am_lfo.setDepth(0);
      this.#am_lfo.setMusicalNote((this.#midiNote ?? 60) + this.#am_lfo_semitone_offset);
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
    this.#envelopes.forEach((env) => env.dispose());
    this.#envelopes.clear();

    const durationSeconds = this.#sampleDurationSeconds || 1;
    const types = getSampleEnvelopeIds(this.#chainIncludes('lpf'));

    for (const type of types) {
      // Envelopes start from defaults; SamplePlayer pushes the real state down as soon
      // as it has one, which is also what keeps every voice on the same shape.
      const settings = createDefaultSampleEnvelopeSettings(type, durationSeconds);
      const envelope = new EnvelopeRuntime(this.context, settings);
      this.#envelopes.set(type, envelope);
    }
  }

  async loadBuffer(buffer: AudioBuffer, zeroCrossings?: number[]): Promise<boolean> {
    return this.loadLayers([buffer], zeroCrossings);
  }

  /**
   * Replace the whole layer set. Layers are summed at one shared playhead, so
   * layer 0 is the authority for duration and all range math; the rest only
   * add samples. A layer at the wrong sample rate is dropped on its own,
   * leaving the others playable, except layer 0: losing it fails the load.
   */
  async loadLayers(buffers: AudioBuffer[], zeroCrossings?: number[]): Promise<boolean> {
    const usable = buffers.filter((buffer) => {
      if (buffer.sampleRate !== this.context.sampleRate) {
        console.warn(
          `Sample rate mismatch - buffer: ${buffer.sampleRate}, context: ${this.context.sampleRate}`,
        );
        return false;
      }
      return true;
    });

    // Layer 0 is the authority for duration and loop range, so if it was
    // dropped the remaining layers would silently play to the wrong ranges.
    if (!usable.length || usable[0] !== buffers[0]) {
      console.error(
        'SampleVoice.loadLayers: layer 0 is unusable, nothing loaded. Layer 0 sets duration and loop range for all layers.',
      );
      return false;
    }

    // postMessage structured-clones each channel, so no local copy needed
    const layers = usable.map((buffer) =>
      Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
    );

    // The processor drops isPlaying when it swaps layers and never echoes a
    // stop for it, so end the note here or the voice stays PLAYING in silence.
    this.stop();

    this.sendToProcessor({
      type: 'voice:setLayers',
      layers,
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
    const { midiNote, velocity, secondsFromNow = 0 } = options;

    const timestamp = this.now + secondsFromNow;

    // An unloaded voice sounds nothing and cannot complete naturally, so it
    // must not enter PLAYING.
    if (!this.#hasLoadedAudio) return null;

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

    if (!this.#pitchDisabled) {
      playbackRate = midiToPlaybackRate(midiNote);
      if (options.glide) {
        prevRate = midiToPlaybackRate(options.glide.prevMidiNote);
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
    this.sendUpstreamMessage('voice:started', {
      voice: this,
      midiNote: this.#midiNote,
    });

    // Apply amp, filter and pitch envelopes if enabled
    this.applyEnvelopes(timestamp, playbackRate, velocity);

    // Trigger effects
    this.#feedback?.trigger(midiNote, {
      velocity,
      secondsFromNow,
      glideTime: scaledGlideTime,
      triggerDecay: true,
    });

    this.#am_lfo?.setMusicalNote(midiNote + this.#am_lfo_semitone_offset, {
      divisor: 1,
      glideTime: scaledGlideTime,
      glideFromMidiNote: options.glide
        ? options.glide.prevMidiNote + this.#am_lfo_semitone_offset
        : undefined,
      timestamp,
    });

    return this.#midiNote;
  }

  /** Trigger inputs of the current note, kept so a settings edit can restart from them. */
  #lastTrigger: { playbackRate: number; velocity?: number } | null = null;

  /** Envelopes synced to playback rate stretch with the note; the rest keep their own timing. */
  #timeScaleMultiplier(envType: SampleEnvelopeId, playbackRate: number) {
    return this.#playbackRateSyncedEnvelopes.has(envType) ? playbackRate : 1;
  }

  #triggerEnvelope(
    envType: SampleEnvelopeId,
    env: EnvelopeRuntime,
    timestamp: number,
    playbackRate: number,
    velocity?: number,
    fromPoint = 0,
  ) {
    if (!shouldTriggerSampleEnvelope(envType, env.settings)) return;
    const param = this.getParam(getSampleEnvelopeParamName(envType));
    if (!param) return;

    const baseValue = getSampleEnvelopeBaseValue(envType, {
      velocity,
      playbackRate,
      filterCutoff: this.#keytrackedLpfHz(playbackRate),
    });
    const target = resolveSampleEnvelopeTrigger(envType, env.settings.envelope, baseValue, param);
    const timeScaleMultiplier = this.#timeScaleMultiplier(envType, playbackRate);

    env.trigger(param, timestamp, { ...target, timeScaleMultiplier, fromPoint });
  }

  applyEnvelopes(timestamp: number, playbackRate: number, velocity?: number) {
    this.#lastTrigger = { playbackRate, velocity };
    this.#envelopes.forEach((env, envType) => {
      this.#triggerEnvelope(envType, env, timestamp, playbackRate, velocity);
    });

    const envDurations = Object.fromEntries(
      Array.from(this.#envelopes, ([envType, env]) => [
        envType,
        env.duration(this.#timeScaleMultiplier(envType, playbackRate)),
      ]),
    );
    const loopEnabled = Object.fromEntries(
      Array.from(this.#envelopes, ([envType, env]) => [envType, env.loop]),
    );

    this.sendUpstreamMessage('sample-envelopes:trigger', {
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

  release({ releaseTime = this.releaseTime, secondsFromNow = 0 }): this {
    // An immediate release must also stop a voice already in its release tail.
    if (releaseTime <= 0) return this.stop(this.now + secondsFromNow);
    if (this.#state !== VoiceState.PLAYING) return this;

    const envGain = this.getParam('envGain');
    if (!envGain) throw new Error('Cannot release - envGain parameter is null');

    this.#transitionTo(VoiceState.RELEASING);
    const timestamp = this.now + secondsFromNow;
    const playbackRate = this.getParam('playbackRate')?.value ?? 1;

    // Release all enabled envelopes
    this.#envelopes.forEach((env) => {
      if (!env.enabled) return;
      env.release(timestamp);
    });

    this.sendToProcessor({ type: 'voice:release', timestamp });
    this.sendUpstreamMessage('voice:releasing', {
      voiceId: this.nodeId,
      voice: this,
      midiNote: this.#midiNote,
    });

    // Get longest release time of enabled envelopes
    const enabledEnvelopes = Array.from(this.#envelopes).filter(([, env]) => env.enabled);

    const effectiveReleaseTime =
      enabledEnvelopes.length > 0
        ? Math.max(
            ...enabledEnvelopes.map(([envType, env]) =>
              env.releaseDuration(this.#timeScaleMultiplier(envType, playbackRate)),
            ),
          )
        : releaseTime; // Fallback passed in release time

    // Stop after the release duration.
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
      effectiveReleaseTime * 1000 + 50,
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
    this.sendUpstreamMessage('voice:stopped', {
      voiceId: this.nodeId,
      voice: this,
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

  /**
   * The LPF cutoff with keytracking applied. This is the cutoff the filter
   * envelope sweeps from, so keytracking and the envelope compose instead of
   * the envelope resetting the cutoff back to the untracked base.
   */
  #keytrackedLpfHz(playbackRate: number = this.getParam('playbackRate')?.value ?? 1): number {
    const keytrackedHz = getKeytrackedFilterHz(this.#lpfHz, playbackRate, this.#keytrackLPFAmount);
    return clampHz(keytrackedHz, this.context.sampleRate);
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

    const safeHz = this.#keytrackedLpfHz(playbackRate);

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

  setModulationAmount(modType: 'AM' | 'FM', amount: number) {
    if (modType === 'AM' && !this.#chainIncludes('am')) return this;

    const safeAmount = mapToRange(amount, 0, 1, 0, 0.95, {
      warn: true,
      name: 'sampleVoice.setModulationAmount',
    });

    if (modType === 'AM') {
      this.#am_lfo?.setDepth(safeAmount);
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

  /** A disabled filter envelope leaves the cutoff wherever it stopped, so restore it. */
  #resetFilterEnvTarget = (envType: SampleEnvelopeId) => {
    if (envType === 'filter-env' && this.#chainIncludes('lpf')) {
      const lpf = this.getParam('lpf');
      lpf?.cancelScheduledValues(this.now);
      // Reset to the keytracked cutoff after the envelope is disabled
      lpf?.setValueAtTime(this.#keytrackedLpfHz(), this.now + 0.01);
    }
  };

  getEnvelope = (envType: SampleEnvelopeId): EnvelopeRuntime | undefined => {
    return this.#envelopes.get(envType);
  };

  /**
   * The only way envelope state reaches a voice. `SamplePlayer` owns the single copy
   * and pushes it down whole, so there is nothing here that can drift out of step with
   * it, and no second entry point that could mean something different.
   */
  applyEnvelopeSettings = (envType: SampleEnvelopeId, settings: EnvelopeSettings) => {
    const envelope = this.#envelopes.get(envType);
    if (!envelope) return;

    if (envelope.enabled && !settings.enabled) {
      envelope.applySettings(settings);
      envelope.stop();
      this.#resetFilterEnvTarget(envType);
      return;
    }

    // Loop switched on mid-note has no cycle boundary to hand over on: the run is not
    // looping yet. Resume from the point it has reached instead, so the shape carries on
    // into its first full cycle rather than snapping back to point 0.
    const resumeFrom = settings.envelope.loop && !envelope.loop ? envelope.currentPoint() : null;
    if (resumeFrom !== null) {
      envelope.applySettings(settings);
      this.#retriggerAt(envType, envelope, this.now, resumeFrom);
      return;
    }

    applyOnNextEnvLoopCycle(
      envelope,
      () => envelope.applySettings(settings),
      (at) => this.#retriggerAt(envType, envelope, at),
    );
  };

  /** Restarts an envelope from the current note's trigger inputs, for a live edit. */
  #retriggerAt(envType: SampleEnvelopeId, envelope: EnvelopeRuntime, at: number, fromPoint = 0) {
    if (!this.#lastTrigger) return;
    const { playbackRate, velocity } = this.#lastTrigger;
    this.#triggerEnvelope(envType, envelope, at, playbackRate, velocity, fromPoint);
  }

  /**
   * The sync flag is read at trigger time, so a running envelope only takes the new
   * time scale on a re-trigger; hand it over on the next loop boundary like a shape edit.
   */
  setEnvelopePlaybackRateSync = (envType: SampleEnvelopeId, sync: boolean) => {
    const apply = () => {
      if (sync) this.#playbackRateSyncedEnvelopes.add(envType);
      else this.#playbackRateSyncedEnvelopes.delete(envType);
    };

    const envelope = this.#envelopes.get(envType);
    if (!envelope) {
      apply();
      return;
    }

    applyOnNextEnvLoopCycle(envelope, apply, (at) => this.#retriggerAt(envType, envelope, at));
  };

  get envelopes() {
    return this.#envelopes;
  }

  setStartPoint = (time: number, timestamp = this.now) => {
    this.setParam('startPoint', time, timestamp);
  };

  setEndPoint = (time: number, timestamp = this.now) => {
    this.setParam('endPoint', time, timestamp);
  };

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
    if (!param || param.value === targetValue) return this;

    const { glideTime = 0, cancelPrevious = true } = options;

    if (cancelPrevious) param.cancelScheduledValues(timestamp);

    if (glideTime <= 0) param.setValueAtTime(targetValue, Math.max(timestamp, this.now + 0.001));
    else param.linearRampToValueAtTime(targetValue, timestamp + Math.max(glideTime, 0.001));

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

  setLoopPoints(start: number, end: number, timestamp = this.now, rampTime = 0): this {
    if (start >= end) return this;

    if (start !== undefined) {
      this.setParam('loopStart', start, timestamp, {
        glideTime: rampTime,
        cancelPrevious: true,
      });
    }
    if (end !== undefined) {
      this.setParam('loopEnd', end, timestamp, {
        glideTime: rampTime,
        cancelPrevious: true,
      });
    }

    return this;
  }

  syncLoopToTempo(enabled: boolean) {
    this.sendToProcessor({
      type: 'syncLoopToTempo',
      value: enabled,
    });
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

  setAllowedPeriods(periods: number[]): this {
    this.sendToProcessor({
      type: 'setAllowedPeriods',
      allowedPeriods: periods,
    });

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
      const rate = midiToPlaybackRate(this.#midiNote);
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

  sendUpstreamMessage(type: string, data: any) {
    this.#messages.sendMessage(type, data);
    return this;
  }

  #setupWorkletMessageHandling() {
    this.#playerWorklet.port.onmessage = (event: MessageEvent) => {
      let { type, ...data } = event.data;

      switch (type) {
        case 'initialized':
          this.#isInitialized = true;

          this.sendUpstreamMessage('voice:initialized', {
            voice: this,
            voiceId: this.nodeId,
          });
          break;

        case 'voice:loaded':
          if (data.durationSeconds) {
            this.#sampleDurationSeconds = data.durationSeconds;

            this.#createEnvelopes();

            this.setStartPoint(0);
            this.setEndPoint(data.durationSeconds);
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
            voice: this,
            midiNote,
          };
          break;
        }

        // Forwarded upstream by the tail call, nothing to do here.
        case 'loop:enabled':
        case 'loop:syncToTempo':
        case 'voice:reset':
        case 'voice:playbackDirectionChange':
          break;

        case 'voice:position':
          this.getParam('playbackPosition')?.setValueAtTime(
            data.position,
            this.context.currentTime,
          );
          break;

        default:
          console.warn(`Unhandled message type: ${type}`);
          break;
      }

      this.sendUpstreamMessage(type, data);
    };
  }

  // Getters

  getPlaybackDuration() {
    const startPoint = this.getParam('startPoint')!.value;
    const endPoint = this.getParam('endPoint')!.value;
    return endPoint - startPoint;
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

  get releaseTime() {
    return this.#envelopes.get('amp-env')!.releaseDuration();
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
    this.sendToProcessor({
      type: 'setLoopEnabled',
      value: enabled,
    });

    if (!enabled && this.#state === VoiceState.PLAYING) this.release({});
    return this;
  }

  setPlaybackRate(
    rate: number,
    atTime = this.now,
    options?: {
      glideTime?: number;
      cancelPrevious?: boolean;
    },
  ): this {
    this.setParam('playbackRate', rate, atTime, options);
    this.#updateHPFCutoffForPlaybackRate(rate, atTime, options);
    this.#updateLPFCutoffForPlaybackRate(rate, atTime, options);
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

  setLoopDurationDriftAmount(amount: number): this {
    if (amount === 0) {
      this.setParam('loopDurationDriftAmount', 0, this.now);
      return this;
    }

    const NEAR_ZERO_FOR_GEOMETRIC = 0.0001; // outputRange.min must be > 0
    const MAX_LOOP_DRIFT = 1; // todo: use audio param's maxValue

    const interpolated = interpolateLinearToGeometric(amount, {
      inputRange: { min: 0, max: 1 },
      outputRange: {
        min: NEAR_ZERO_FOR_GEOMETRIC,
        max: MAX_LOOP_DRIFT,
      },
      blend: 1, // blend: 0.5 = 50% geometric, 50% linear
      curve: 'linear',
    });
    this.setParam('loopDurationDriftAmount', interpolated, this.now);
    return this;
  }

  setPanDriftEnabled = (enabled: boolean) =>
    this.sendToProcessor({ type: 'setPanDriftEnabled', value: enabled });

  setTimestretchEnabled = (enabled: boolean) =>
    this.sendToProcessor({ type: 'setPreserveDuration', value: enabled });

  setAMModOctaveOffset(offset: number) {
    assert(
      offset >= samplerParams.amModOctaveOffset.min &&
        offset <= samplerParams.amModOctaveOffset.max,
      `AM modulation octave offset must be between ${samplerParams.amModOctaveOffset.min} and ${samplerParams.amModOctaveOffset.max}`,
    );
    const semitoneOffset = offset * 12; // convert octaves to semitones
    this.#am_lfo_semitone_offset = semitoneOffset;
    if (this.#am_lfo && this.#midiNote !== null) {
      this.#am_lfo.setMusicalNote(this.#midiNote + semitoneOffset);
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
    this.#envelopes.forEach((env) => env.dispose());
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
      default:
        return null;
    }
  }
}
