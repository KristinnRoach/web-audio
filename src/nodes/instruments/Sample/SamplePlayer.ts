// SamplePlayer.ts - Refactored with Composition Pattern

import { Message, MessageHandler } from '@/events';
import { detectSinglePitchAC } from '@/utils/audiodata/pitchDetection';
import { trimAudioBuffer } from '@/utils/audiodata/process/trimBuffer';
import { clamp, findClosestNote, ROOT_NOTES } from '@/utils';

import {
  preProcessAudioBuffer,
  PreProcessOptions,
  PreProcessResults,
} from '@/nodes/preprocessor/Preprocessor';

import { isValidAudioBuffer, isMidiValue } from '@/utils';
import type { Note } from '@/utils/music-theory/types';

import { MacroParam, NormalizeOptions } from '@/nodes/params';

import {
  isValidSamplerParamValue,
  samplerParams,
  type SamplerParamPatch,
  type SamplerParamKey,
  type SamplerParamDescriptor,
} from './sampler-params';

import { LFO } from '@/nodes/params/LFOs/LFO';
import {
  createInstrumentBus,
  type InstrumentBus,
} from '@/nodes/master/createInstrumentBus';
import { BusNodeName } from '@/nodes/master/InstrumentBus';
import { SampleVoicePool } from './SampleVoicePool';
import { CustomEnvelope } from '@/nodes/params';
import { EnvelopeType } from '@/nodes/params/envelopes';
import { ILibInstrumentNode } from '@/nodes/LibAudioNode';
import { registerNode, unregisterNode, NodeID } from '@/nodes/node-store';
import { createMessageBus, MessageBus } from '@/events';
import {
  CustomLibWaveform,
  WaveformOptions,
} from '@/utils/audiodata/generate/generateWaveform';
import { createSampleVoicePool } from './createSampleVoicePool';

export class SamplePlayer implements ILibInstrumentNode {
  public readonly nodeId: NodeID;
  readonly nodeType = 'sample-player' as const;
  readonly context: AudioContext;
  #messages: MessageBus<Message>;

  #initialized = false;
  #initPromise: Promise<void> | null = null;
  #isLoaded = false;
  #polyphony: number;
  #initialAudioBuffer: AudioBuffer | null = null;

  #connections = new Set<NodeID>();
  #incoming = new Set<NodeID>();

  #audiobuffer: AudioBuffer | null = null;
  #bufferDuration: number = 0;

  #loopEnabled = false;
  #loopLocked = false;
  #holdEnabled = false;
  #holdLocked = false;
  #sustainPedalPressed = false;

  #masterOut: GainNode;

  #macroLoopStart: MacroParam;
  #macroLoopEnd: MacroParam;
  #gainLFO: LFO | null = null;
  #pitchLFO: LFO | null = null;

  #transposedBySemitones = 0;

  #tempo = 120;
  #glideTime: number = samplerParams.glide.defaultValue;
  #loopRampDuration: number = samplerParams.loopRampDuration.defaultValue;
  #keytrackLoopAmount: number = samplerParams.keytrackLoop.defaultValue;
  #hpfCutoff: number = samplerParams.highpassFilter.defaultValue;
  #lpfCutoff: number = samplerParams.lowpassFilter.defaultValue;
  #loopTempoSync = false; // TODO: Implement!
  #MAX_TEMPO = 300;
  #MIN_TEMPO = 20;

  #syncGainLFOToMidiNote = false;
  #syncPitchLFOToMidiNote = false;

  #zeroCrossings: number[] = [];
  #useZeroCrossings = true;
  #preprocessAudio = true;
  randomizeVelocity = false;

  voicePool!: SampleVoicePool; // todo: fix use of '!'
  outBus!: InstrumentBus; // todo: fix use of '!'

  // ? move to input controller ?
  #sustainedNotes = new Set<MidiValue>();

  constructor(
    context: AudioContext,
    polyphony: number = 16,
    audioBuffer?: AudioBuffer,
  ) {
    this.nodeId = registerNode('sample-player', this);
    this.context = context;

    // Synchronus setup
    this.#messages = createMessageBus<Message>(this.nodeId);

    this.#masterOut = new GainNode(this.context, { gain: 0.5 });

    // Seconds; the real loop range is set from the buffer duration in
    // #resetMacros once a sample is loaded.
    this.#macroLoopStart = new MacroParam(this.context, 0);
    this.#macroLoopEnd = new MacroParam(this.context, 0);

    // Store configuration for async init
    this.#polyphony = polyphony;
    this.#initialAudioBuffer = audioBuffer || null;
  }

  async init(): Promise<void> {
    if (this.#initialized) return; // todo: remove #initialized flag if redundant (since now using initPromise)
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      try {
        // Initialize child components first
        this.outBus = await createInstrumentBus(this.context); // WIP
        this.voicePool = await createSampleVoicePool(
          this.context,
          this.#polyphony,
        );

        this.#resetMacros();

        // Connect audio chain
        this.#connectAudioChain();
        this.#connectVoicesToMacros();
        this.#setupLFOs();
        this.#setupMessageHandling();

        // Load initial sample if provided
        if (this.#initialAudioBuffer) {
          await this.loadSample(this.#initialAudioBuffer, undefined, {
            skipPreProcessing: true, // Skip preprocessing for init sample (likely already processed)
          });
        }

        this.#initialized = true;
      } catch (error) {
        // Cleanup any partial initialization
        this.voicePool?.dispose();
        this.#macroLoopStart?.dispose();
        this.#macroLoopEnd?.dispose();

        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to initialize SamplePlayer: ${errorMessage}`);
      }
    })();
    return this.#initPromise;
  }

  #connectAudioChain() {
    this.voicePool.connect(this.outBus.input);
    this.outBus.connect(this.#masterOut);
    this.#masterOut.connect(this.context.destination);
  }

  // === MESSAGING ===

  public onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  public sendUpstreamMessage(type: string, data: any): this {
    this.#messages.sendMessage(type, data);
    return this;
  }

  // === CONNECTIONS ===

  public connect(destination: ILibInstrumentNode | AudioNode): void {
    const target =
      'input' in destination && destination.input
        ? destination.input
        : destination;

    this.#masterOut.connect(target as AudioNode);

    // Track the connection by NodeID if possible
    if ('nodeId' in destination) {
      this.#connections.add(destination.nodeId);
      (destination as any).addIncoming?.(this.nodeId);
    }
  }

  public disconnect(destination?: ILibInstrumentNode | AudioNode): void {
    if (destination) {
      const target = 'input' in destination ? destination.input : destination;
      this.#masterOut.disconnect(target as AudioNode);
      if ('nodeId' in destination) {
        this.#connections.delete(destination.nodeId);
        (destination as any).removeIncoming?.(this.nodeId);
      }
    } else {
      // Disconnect all
      this.#masterOut.disconnect();
      this.#connections.clear();
    }
  }

  addIncoming(source: ILibInstrumentNode): void {
    this.#incoming.add(source.nodeId);
  }

  removeIncoming(source: ILibInstrumentNode): void {
    this.#incoming.delete(source.nodeId);
  }

  get connections() {
    return {
      outgoing: Array.from(this.#connections),
      incoming: Array.from(this.#incoming),
    };
  }

  // === CONVENIENCE GETTERS ===

  get audioNode() {
    return this.#masterOut;
  }

  get input() {
    return this.outBus.input;
  }

  get output() {
    return this.#masterOut;
  }

  get now(): number {
    return this.context.currentTime;
  }

  get initialized() {
    return this.#initialized;
  }

  /* === MESSAGES === */

  #setupMessageHandling(): this {
    this.voicePool.onMessage('sample:loaded', (msg: Message) => {
      this.#isLoaded = true;
    });

    this.voicePool.onMessage('voice-pool:initialized', () => {
      this.sendUpstreamMessage('sample-player:initialized', {});
    });

    // Forward voice pool messages upstream
    this.#messages.forwardFrom(this.voicePool, [
      'voice-pool:initialized',
      'voice:started',
      'voice:stopped',
      'voice:releasing',
      'sample:loaded',

      'amp-env:created',
      'amp-env:trigger',
      'amp-env:trigger:loop',
      'amp-env:release',

      'pitch-env:created',
      'pitch-env:trigger',
      'pitch-env:trigger:loop',
      'pitch-env:release',

      'filter-env:created',
      'filter-env:trigger',
      'filter-env:trigger:loop',
      'filter-env:release',
    ]);
    return this;
  }

  /* === MACROS === */

  getMacrosAudioParam(paramName: 'loopStart' | 'loopEnd') {
    switch (paramName) {
      case 'loopStart':
        return this.#macroLoopStart.audioParam;
      case 'loopEnd':
        return this.#macroLoopEnd.audioParam;
      default:
        const unreachable: never = paramName;
        throw new Error(`Unknown macro parameter: ${unreachable}`);
    }
  }

  getMacro(paramName: 'loopStart' | 'loopEnd') {
    switch (paramName) {
      case 'loopStart':
        return this.#macroLoopStart;
      case 'loopEnd':
        return this.#macroLoopEnd;
      default:
        const unreachable: never = paramName;
        throw new Error(`Unknown macro parameter: ${unreachable}`);
    }
  }

  #connectVoicesToMacros(): this {
    const voices = this.voicePool.allVoices;

    voices.forEach((voice, index) => {
      const loopStartParam = voice.getParam('loopStart');
      const loopEndParam = voice.getParam('loopEnd');

      if (loopStartParam) {
        this.#macroLoopStart.addTarget(loopStartParam, 'loopStart');
      } else {
        console.error('loopStart param is null!');
      }

      if (loopEndParam) {
        this.#macroLoopEnd.addTarget(loopEndParam, 'loopEnd');
      } else {
        console.error('loopEnd param is null!');
      }
    });

    return this;
  }

  #resetMacros() {
    this.#macroLoopStart.setValue(0);

    this.#macroLoopEnd.setValue(this.#bufferDuration);

    return this;
  }

  /* === LFOs === */

  setModulationAmount = (modType: 'AM' | 'FM', amount: number) =>
    this.voicePool.applyToAllVoices((v) =>
      v.setModulationAmount(modType, amount),
    );

  setModulationWaveform(
    modType: 'AM' | 'FM' = 'AM',
    waveform: CustomLibWaveform | OscillatorType | PeriodicWave = 'triangle',
    customWaveOptions: WaveformOptions = {},
  ) {
    this.voicePool.applyToAllVoices((v) =>
      v.setModulationWaveform(modType, waveform, customWaveOptions),
    );
  }

  syncLFOsToNoteFreq(lfoId: 'gain-lfo' | 'pitch-lfo', enabled: boolean) {
    if (lfoId === 'gain-lfo') {
      if (enabled === true) {
        this.#gainLFO?.storeCurrentValues();
      } else {
        const storedVals = this.#gainLFO?.getStoredValues();
        storedVals && this.#gainLFO?.setFrequency(storedVals.rate);
      }

      this.#syncGainLFOToMidiNote = enabled;
    }
    if (lfoId === 'pitch-lfo') {
      if (enabled === true) {
        this.#pitchLFO?.storeCurrentValues();
      } else {
        const storedVals = this.#pitchLFO?.getStoredValues();
        storedVals && this.#pitchLFO?.setFrequency(storedVals.rate);
      }

      this.#syncPitchLFOToMidiNote = enabled;
    }
  }

  #setupLFOs() {
    this.#gainLFO = new LFO(this.context);
    this.#gainLFO.setWaveform('sine');

    this.#pitchLFO = new LFO(this.context);
    const wobbleWave = this.#pitchLFO.getPitchWobbleWaveform();
    this.#pitchLFO.setWaveform(wobbleWave);

    // Connections
    this.#connectLFOToAllVoices(this.#pitchLFO, 'playbackRate');
    this.#gainLFO.connect(this.outBus.input.gain);
    // this.#connectLFOToAllVoices(this.#gainLFO, 'playbackPosition');
  }

  #connectLFOToAllVoices(lfo: LFO, paramName: string) {
    this.voicePool.applyToAllVoices((voice) => {
      const param = voice.getParam(paramName);
      if (param) lfo.connect(param);
    });
  }

  freezeActiveVoices(freeze: boolean): this {
    console.info(
      `SamplePlayer: freezeActiveVoices(${freeze}). Spectral freeze not implemented yet`,
    );
    // this.voicePool.applyToActiveVoices((voice) => voice.freeze(freeze));
    return this;
  }

  /* === LOAD / RESET === */

  #isLoading = false;

  async loadSample(
    buffer: AudioBuffer | ArrayBuffer,
    modSampleRate?: number,
    preprocessOptions?: Partial<PreProcessOptions>,
  ): Promise<AudioBuffer | null> {
    if (this.#isLoading) {
      throw new Error('A sample load is already in progress');
    }
    this.#isLoading = true;
    let unsubscribe: (() => void) | undefined;

    try {
      if (buffer instanceof ArrayBuffer) {
        // decodeAudioData detaches its input; copy so callers can safely
        // reuse/re-pass the same ArrayBuffer (e.g. re-selecting a cached sample).
        buffer = await this.context.decodeAudioData(buffer.slice(0));
      }

      if (!isValidAudioBuffer(buffer)) {
        console.error('Invalid AudioBuffer provided to loadSample');
        return null;
      }

      if (buffer.sampleRate !== this.context.sampleRate) {
        throw new RangeError(
          `Sample rate mismatch: buffer rate ${buffer.sampleRate}, context rate ${this.context.sampleRate}`,
        );
      }

      if (modSampleRate && this.context.sampleRate !== modSampleRate) {
        console.warn(
          `Sample rate mismatch: context rate ${this.context.sampleRate}, requested rate ${modSampleRate}`,
        );
      }

      this.releaseAll(0);
      this.transposeSemitones = 0;
      this.#isLoaded = false;
      this.#audiobuffer = null;

      let processed: PreProcessResults | undefined;

      if (this.#preprocessAudio) {
        processed = await preProcessAudioBuffer(
          this.context,
          buffer,
          preprocessOptions,
        );
        buffer = processed.audiobuffer;

        if (this.#useZeroCrossings && processed.zeroCrossings) {
          this.#zeroCrossings = processed.zeroCrossings;
        }
      }

      this.#audiobuffer = buffer;
      this.#bufferDuration = buffer.duration;

      const loadedPromise = new Promise<void>((resolve) => {
        unsubscribe = this.voicePool.onMessage('sample:loaded', () => {
          resolve();
        });
      });

      this.voicePool.setBuffer(buffer, this.#zeroCrossings);
      this.#resetMacros();

      const defaultScaleOptions = {
        rootNote: 'C' as keyof typeof ROOT_NOTES,
        scale: [0],
        lowestOctave: 0,
        highestOctave: 5,
        tuningOffset: 0,
        normalize: false as NormalizeOptions | false,
      };

      this.setScale(defaultScaleOptions);

      await loadedPromise;
      return buffer;
    } finally {
      unsubscribe?.();
      this.#isLoading = false;
    }
  }

  async cropSample(
    startSeconds = this.getStartPoint(),
    endSeconds = this.getEndPoint(),
    fadeMs = 4,
  ): Promise<AudioBuffer | null> {
    const buffer = this.#audiobuffer;
    if (!buffer) return null;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      return null;
    }

    const startSample = Math.max(
      0,
      Math.floor(startSeconds * buffer.sampleRate),
    );
    const endSample = Math.min(
      buffer.length,
      Math.ceil(endSeconds * buffer.sampleRate),
    );

    if (endSample <= startSample) return null;

    const croppedBuffer = trimAudioBuffer(
      this.context,
      buffer,
      startSample,
      endSample,
      fadeMs,
    );

    return this.loadSample(croppedBuffer, undefined, {
      skipPreProcessing: true,
    });
  }

  async detectPitch(buffer: AudioBuffer): Promise<{
    frequency: number;
    confidence: number;
    midiFloat: number;
    targetNoteInfo: Note;
  }> {
    const pitchSource = await detectSinglePitchAC(buffer);
    const targetNoteInfo = findClosestNote(pitchSource.frequency);
    const midiFloat = 69 + 12 * Math.log2(pitchSource.frequency / 440);
    const playbackRateMultiplier =
      targetNoteInfo.frequency / pitchSource.frequency;

    console.table({
      pitchSource,
      targetNoteInfo,
      playbackRateMultiplier,
      midiFloat,
    });

    this.sendUpstreamMessage('sample:pitch-detected', {
      pitchResults: pitchSource,
      closestNoteInfo: targetNoteInfo,
    });

    return {
      frequency: pitchSource.frequency,
      confidence: pitchSource.confidence,
      midiFloat,
      targetNoteInfo,
    };
  }

  detectedPitchToTransposition(
    detectedMidiFloat: number,
    targetMidiNote: number,
  ) {
    let transposeSemitones = targetMidiNote - detectedMidiFloat;
    // Wrap to nearest octave (-6 to +6 semitones)
    while (transposeSemitones > 6) transposeSemitones -= 12;
    while (transposeSemitones < -6) transposeSemitones += 12;
    return transposeSemitones;
  }

  /* === PLAYBACK === */

  play(
    midiNote: MidiValue,
    velocity: MidiValue = 100,
    glideTime = this.getGlideTime(),
  ): MidiValue | null {
    const safeVelocity = isMidiValue(velocity) ? velocity : 100;
    const transposedMidiNote = midiNote + this.#transposedBySemitones;
    if (!isMidiValue(transposedMidiNote)) {
      console.warn(`Invalid midiNote: ${transposedMidiNote}`);
      return null;
    }

    this.#syncGainLFOToMidiNote &&
      this.#gainLFO?.setMusicalNote(transposedMidiNote);
    this.#syncPitchLFOToMidiNote &&
      this.#pitchLFO?.setMusicalNote(transposedMidiNote, { divisor: 4 });

    this.outBus.noteOn(transposedMidiNote, safeVelocity, 0, glideTime);

    return this.voicePool.noteOn(
      transposedMidiNote,
      safeVelocity,
      0,
      glideTime,
    );
  }

  release(midiNote: MidiValue): this {
    if (this.holdEnabled || this.#holdLocked) return this;

    const transposedMidiNote = midiNote + this.#transposedBySemitones;

    if (this.#sustainPedalPressed) {
      this.#sustainedNotes.add(transposedMidiNote);
      return this;
    }

    // Remove from sustained notes if it was there
    this.#sustainedNotes.delete(transposedMidiNote);

    this.voicePool.noteOff(transposedMidiNote);
    this.sendUpstreamMessage('note:off', { transposedMidiNote });
    return this;
  }

  releaseAll(releaseTime?: number): this {
    this.#sustainedNotes.clear();
    this.voicePool?.allNotesOff(releaseTime);
    return this;
  }

  // Common functionality for all instruments
  panic = (releaseTime?: number) => this.releaseAll(releaseTime);

  /* === SCALE SETTINGS === */

  get transposedBySemitones() {
    return this.#transposedBySemitones;
  }

  set transposeSemitones(semitones: number) {
    if (this.#transposedBySemitones === semitones) return;
    this.#transposedBySemitones = semitones;
  }

  setScale(options: {
    rootNote: keyof typeof ROOT_NOTES;
    scale: number[];
    tuningOffset: number;
    highestOctave: number;
    lowestOctave: number;
    normalize: NormalizeOptions | false;
  }) {
    this.#macroLoopStart.setScale({
      snapToZeroCrossings: this.#zeroCrossings,
      ...options,
    });
    this.#macroLoopEnd.setScale({
      snapToZeroCrossings: this.#zeroCrossings,
      ...options,
    });
    return this;
  }

  setRootNote(note: keyof typeof ROOT_NOTES) {
    const rootNoteNumber = ROOT_NOTES[note];

    let semitones = rootNoteNumber === 0 ? 0 : rootNoteNumber - 12;

    if (this.transposedBySemitones === semitones) return this;

    this.transposeSemitones = semitones;

    this.#macroLoopEnd.setRootNote(note);
    this.#macroLoopStart.setRootNote(note);

    return this;
  }

  /** PARAM SETTERS  */

  setVolume(volume: number): this {
    volume = clamp(volume, 0, 1);
    this.#masterOut.gain.setValueAtTime(volume, this.now);
    return this;
  }

  setSampleStartPoint(seconds: number): this {
    this.voicePool.applyToAllVoices((voice) => voice.setStartPoint(seconds));

    this.sendUpstreamMessage('start-point:updated', {
      startPoint: seconds,
    });
    return this;
  }

  setSampleEndPoint(seconds: number): this {
    this.voicePool.applyToAllVoices((voice) => voice.setEndPoint(seconds));

    this.sendUpstreamMessage('end-point:updated', {
      endPoint: seconds,
    });
    return this;
  }

  setLoopRampDuration(seconds: number): this {
    this.#loopRampDuration = seconds;
    return this;
  }

  setGlideTime(seconds: number): this {
    this.#glideTime = seconds;
    return this;
  }

  setLoopEnabled(enabled: boolean): this {
    if (this.#loopEnabled === enabled) return this;

    // if loop is locked (ON), turning it off is disabled but turning it on should work
    if (this.#loopLocked && !enabled) return this;

    const voices = this.voicePool.allVoices;
    voices.forEach((v) => v.setLoopEnabled(enabled));
    this.#loopEnabled = enabled;

    this.sendUpstreamMessage('loop:enabled', { enabled });
    return this;
  }

  setLoopLocked(locked: boolean): this {
    if (this.#loopLocked === locked) return this;

    this.#loopLocked = locked;
    this.setLoopEnabled(locked);

    this.sendUpstreamMessage('loop:locked', { locked });
    return this;
  }

  setHoldEnabled(enabled: boolean) {
    if (this.#holdEnabled === enabled) return this;
    if (this.#holdLocked && !enabled) return this;

    this.#holdEnabled = enabled;
    if (!enabled) this.releaseAll(0.1);
    this.sendUpstreamMessage('hold:enabled', { enabled });
    return this;
  }

  setHoldLocked(locked: boolean): this {
    if (this.#holdLocked === locked) return this;

    this.#holdLocked = locked;
    if (locked === false) this.releaseAll();

    this.sendUpstreamMessage('hold:locked', { locked });
    return this;
  }

  #sustainPedalLoopFlag: boolean = false;

  setSustainPedal(pressed: boolean): this {
    if (this.#sustainPedalPressed === pressed) return this;

    this.#sustainPedalPressed = pressed;

    if (!this.#loopLocked) {
      if (this.#sustainPedalLoopFlag && !pressed) {
        this.#sustainPedalLoopFlag = false;
        this.setLoopEnabled(false);
      } else if (pressed && !this.#loopEnabled) {
        this.setLoopEnabled(true);
        this.#sustainPedalLoopFlag = true;
      }
    }

    if (!this.#holdLocked) {
      this.setHoldEnabled(pressed);
    }

    if (!pressed) {
      for (const note of this.#sustainedNotes) {
        this.voicePool.noteOff(note);
        this.sendUpstreamMessage('note:off', { transposedMidiNote: note });
      }
      this.#sustainedNotes.clear();
    }

    return this;
  }

  sustainPedalOn = (): this => this.setSustainPedal(true);
  sustainPedalOff = (): this => this.setSustainPedal(false);

  setPlaybackDirection(direction: 'forward' | 'reverse'): this {
    this.voicePool.applyToAllVoices((voice) =>
      voice.setPlaybackDirection(direction),
    );
    return this;
  }

  setLoopDurationDriftAmount(amount: number): this {
    this.voicePool.applyToAllVoices((voice) =>
      voice.setLoopDurationDriftAmount(amount),
    );
    return this;
  }

  setPanDriftEnabled = (enabled: boolean) => {
    this.voicePool.applyToAllVoices((voice) =>
      voice.setPanDriftEnabled(enabled),
    );
    return this;
  };

  setTimestretchEnabled = (enabled: boolean) => {
    this.voicePool.applyToAllVoices((voice) =>
      voice.setTimestretchEnabled(enabled),
    );
    return this;
  };

  isNormalized = (value: number, range = [0, 1]) =>
    value >= range[0] && value <= range[1];

  readonly MIN_LOOP_DURATION_SECONDS = 1 / 523.25; // C5 = 523.25 Hz, C6 = 1046.502

  setLoopStart = (
    seconds: number,
    rampTime: number = this.getLoopRampDuration(),
  ) => {
    return this.setLoopPoint('start', seconds, this.loopEnd, rampTime);
  };

  setLoopEnd = (
    seconds: number,
    rampTime: number = this.getLoopRampDuration(),
  ) => {
    return this.setLoopPoint('end', this.loopStart, seconds, rampTime);
  };

  setLoopDuration = (
    seconds: number,
    rampTime: number = this.getLoopRampDuration(),
  ) =>
    this.setLoopPoint(
      'end',
      this.loopStart,
      this.loopStart + seconds,
      rampTime,
    );

  debugcounter = 0;

  setTempo(bpm: number) {
    if (bpm < this.#MIN_TEMPO || bpm > this.#MAX_TEMPO) return;
    this.#tempo = bpm;

    this.voicePool.applyToAllVoices((voice) => voice.setTempo(bpm));

    this.sendUpstreamMessage('tempo:updated', { bpm });
    return this;
  }

  syncLoopToTempo(enabled: boolean) {
    this.voicePool.applyToAllVoices((voice) => voice.syncLoopToTempo(enabled));
    return this;
  }

  // Keytrack loop length to the played note (0 = fixed samples, 1 = constant loop time)
  setKeytrackLoopAmount(amount: number) {
    const clamped = Math.max(0, Math.min(1, amount));
    this.#keytrackLoopAmount = clamped;
    this.voicePool.applyToAllVoices((voice) =>
      voice.setKeytrackLoopAmount(clamped),
    );
    return this;
  }

  getKeytrackLoopAmount = () => this.#keytrackLoopAmount;

  get tempo() {
    return this.#tempo;
  }

  setLoopPoint(
    loopPoint: 'start' | 'end',
    loopStartSeconds: number,
    loopEndSeconds: number,
    rampDuration: number = this.getLoopRampDuration(),
  ) {
    let loopStart =
      loopPoint === 'start'
        ? clamp(
            loopStartSeconds,
            this.MIN_LOOP_DURATION_SECONDS / 2,
            loopEndSeconds,
          )
        : loopStartSeconds;

    if (loopPoint === 'start' && loopStart === this.loopStart) return this;

    let loopEnd = clamp(
      loopEndSeconds,
      loopStart,
      this.#bufferDuration - this.MIN_LOOP_DURATION_SECONDS / 2,
    );

    if (loopPoint === 'end' && loopEnd === this.loopEnd) return this;

    const targetLoopDuration = loopEnd - loopStart;
    const RAMP_SENSITIVITY = 1;
    const scaledRampTime = rampDuration * RAMP_SENSITIVITY;

    if (loopPoint === 'start' && loopStart !== this.loopStart) {
      // handle tempo loop sync for loop start
      if (this.#loopTempoSync) {
        const beatDuration = 60 / this.#tempo;
        const numBeats = Math.round(targetLoopDuration / beatDuration);
        loopStart = loopEnd - numBeats * beatDuration;
      }

      if (targetLoopDuration < this.MIN_LOOP_DURATION_SECONDS) {
        loopStart = loopEnd - this.MIN_LOOP_DURATION_SECONDS;
      }

      this.#macroLoopStart.ramp(loopStart, scaledRampTime, loopEnd);
    } else if (loopPoint === 'end' && loopEnd !== this.loopEnd) {
      // handle tempo loop sync for loop end
      if (this.#loopTempoSync) {
        const beatDuration = 60 / this.#tempo;
        const numBeats = Math.round(targetLoopDuration / beatDuration);
        loopEnd = loopStart + numBeats * beatDuration;
      }

      if (targetLoopDuration < this.MIN_LOOP_DURATION_SECONDS) {
        loopEnd = loopStart + this.MIN_LOOP_DURATION_SECONDS;
      }

      this.#macroLoopEnd.ramp(loopEnd, scaledRampTime, loopStart);
    }

    this.sendUpstreamMessage('loop-points:updated', {
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });

    return this;
  }

  scrollLoopPoints(loopStart: number, loopEnd: number) {
    const timestamp = this.context.currentTime;
    this.#macroLoopStart.setValue(loopStart, timestamp);
    this.#macroLoopEnd.setValue(loopEnd, timestamp);

    this.sendUpstreamMessage('loop-points:updated', {
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });

    return this;
  }

  setParam(name: string, value: number): this {
    switch (name) {
      case 'startPoint':
        this.setSampleStartPoint(value);
        break;
      case 'endPoint':
        this.setSampleEndPoint(value);
        break;
      case 'glideTime':
        this.setGlideTime(value);
        break;
      case 'loopStart':
        this.setLoopStart(value);
        break;
      case 'loopEnd':
        this.setLoopEnd(value);
        break;
      case 'loopRampDuration':
        this.setLoopRampDuration(value);
        break;
      default:
        console.warn(`Unknown parameter: ${name}`);
    }
    return this;
  }

  applyParams(params: SamplerParamPatch): this {
    Object.entries(params).forEach(([key, value]) => {
      const descriptor = samplerParams[key as SamplerParamKey] as
        | SamplerParamDescriptor
        | undefined;
      if (!descriptor || !isValidSamplerParamValue(descriptor, value)) {
        return;
      }
      descriptor.apply(this, value);
    });
    return this;
  }

  /** PARAM GETTERS  */

  getAudioParam(name: string): AudioParam | null {
    switch (name) {
      case 'loopStart':
        return this.#macroLoopStart.audioParam;
      case 'loopEnd':
        return this.#macroLoopEnd.audioParam;
      default:
        console.warn(`Parameter '${name}' not found on SamplePlayer`);
        return null;
    }
  }

  // TODO: Consider moving source of truth from SampleVoice to SamplePlayer, or convert to MacroParams, symmetrical with the loop start/end points
  getStartPoint(): number {
    return this.voicePool?.allVoices[0]?.startPoint ?? 0;
  }

  getEndPoint(): number {
    return this.voicePool?.allVoices[0]?.endPoint ?? this.sampleDuration;
  }

  getLoopRampDuration(): number {
    return this.#loopRampDuration;
  }

  getGlideTime(): number {
    return this.#glideTime;
  }

  getHpfCutoff = () => this.#hpfCutoff;
  getLpfCutoff = () => this.#lpfCutoff;

  getParameterValue(name: string): number | undefined {
    switch (name) {
      case 'loopStart':
        return this.loopStart;
      case 'loopEnd':
        return this.loopEnd;
      case 'loopRampDuration':
        return this.getLoopRampDuration();
      case 'startPoint':
        return this.getStartPoint();
      case 'endPoint':
        return this.getEndPoint();
      case 'glideTime':
        return this.getGlideTime();
      case 'hpfCutoff':
        return this.getHpfCutoff();
      case 'lpfCutoff':
        return this.getLpfCutoff();
      default:
        console.warn(`Unknown parameter: ${name}`);
        return undefined;
    }
  }

  /* === PITCH === */

  enablePitch = () => this.voicePool.allVoices.forEach((v) => v.enablePitch());
  disablePitch = () =>
    this.voicePool.allVoices.forEach((v) => v.disablePitch());

  /* === ENVELOPES === */

  enableEnvelope = (envType: EnvelopeType) => {
    this.voicePool.applyToAllVoices((voice) => voice.enableEnvelope(envType));
  };

  disableEnvelope = (envType: EnvelopeType) => {
    this.voicePool.applyToAllVoices((voice) => voice.disableEnvelope(envType));
  };

  getEnvelope(envType: EnvelopeType): CustomEnvelope {
    const firstVoice = this.voicePool.allVoices[0];
    if (!firstVoice) throw new Error('No voices available in voice pool');

    const envelope = firstVoice.getEnvelope(envType);
    if (!envelope) throw new Error(`Envelope type '${envType}' not found`);

    return envelope;
  }

  setEnvelopeLoop = (
    envType: EnvelopeType,
    loop: boolean,
    mode: 'normal' | 'ping-pong' | 'reverse' = 'normal',
  ) => {
    this.voicePool.applyToAllVoices((v) =>
      v.setEnvelopeLoop(envType, loop, mode),
    );
  };

  setEnvelopeSync = (envType: EnvelopeType, sync: boolean) => {
    this.voicePool.applyToAllVoices((v) =>
      v.syncEnvelopeToPlaybackRate(envType, sync),
    );
  };

  setEnvelopeTimeScale = (envType: EnvelopeType, timeScale: number) => {
    this.voicePool.applyToAllVoices((v) =>
      v.setEnvelopeTimeScale(envType, timeScale),
    );
  };

  setEnvelopeSustainPoint(envType: EnvelopeType, index: number | null) {
    this.voicePool.applyToAllVoices((v) =>
      v.setEnvelopeSustainPoint(envType, index),
    );
  }

  setEnvelopeReleasePoint(envType: EnvelopeType, index: number) {
    this.voicePool.applyToAllVoices((v) =>
      v.setEnvelopeReleasePoint(envType, index),
    );
  }

  updateEnvelopePoint(
    envType: EnvelopeType,
    index: number,
    time: number,
    value: number,
  ): void {
    this.voicePool.applyToAllVoices((v) =>
      v.updateEnvelopePoint(envType, index, time, value),
    );
  }

  addEnvelopePoint(envType: EnvelopeType, time: number, value: number): void {
    this.voicePool.applyToAllVoices((v) =>
      v.addEnvelopePoint(envType, time, value),
    );
  }

  deleteEnvelopePoint(envType: EnvelopeType, index: number): void {
    this.voicePool.applyToAllVoices((v) =>
      v.deleteEnvelopePoint(envType, index),
    );
  }

  startLevelMonitoring(intervalMs?: number) {
    this.outBus.startLevelMonitoring(intervalMs);
  }

  /* === FX === */

  setDryWetMix = (mix: { dry: number; wet: number }) => {
    this.outBus.setDryWetMix(mix);
  };

  sendToFx = (effect: BusNodeName, amount: number) => {
    this.outBus.setSendAmount(effect, amount);
  };

  setLpfCutoff = (hz: number, preOrPostFx: 'pre' | 'post' = 'pre') => {
    this.#lpfCutoff = hz;
    if (preOrPostFx === 'pre') {
      this.voicePool.applyToAllVoices((v) => {
        v.setLpfCutoff(hz);
      });
    } else if (preOrPostFx === 'post') {
      this.outBus.setLpfCutoff(hz);
    }
  };

  setHpfCutoff = (hz: number, preOrPostFx: 'pre' | 'post' = 'pre') => {
    this.#hpfCutoff = hz;
    if (preOrPostFx === 'pre') {
      this.voicePool.applyToAllVoices((v) => {
        v.setHpfCutoff(hz);
      });
    } else if (preOrPostFx === 'post') {
      this.outBus.setHpfCutoff(hz);
    }
  };

  setReverbAmount = (amount: number) => {
    this.outBus.setReverbSize(amount);
  };

  setFeedbackDecay(value: number) {
    this.outBus.setFeedbackDecay(value);
    this.voicePool.applyToAllVoices((voice) => {
      voice.feedback?.setDecay(value);
    });
  }

  setFeedbackLowpassCutoff(freqHz: number) {
    this.outBus.setFeedbackLowpassCutoff(freqHz);

    this.voicePool.applyToAllVoices((voice) => {
      voice.feedback?.setLowpassCutoff(freqHz);
    });
  }

  // === FEEDBACK ===

  setFeedbackAmount = (amount: number) => {
    amount = clamp(amount, 0, 1);
    if (
      this.#feedbackMode === 'monophonic' ||
      this.#feedbackMode === 'double-trouble'
    ) {
      this.outBus.setFeedbackAmount(amount);
    }

    if (
      this.#feedbackMode === 'polyphonic' ||
      this.#feedbackMode === 'double-trouble'
    ) {
      this.voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(amount);
      });
    }
  };

  #feedbackMode: 'monophonic' | 'polyphonic' | 'double-trouble' = 'monophonic';

  setFeedbackMode(mode: 'monophonic' | 'polyphonic' | 'double-trouble') {
    this.#feedbackMode = mode;

    if (mode === 'monophonic') {
      let currAmount = this.voicePool.allVoices[0].feedback?.currentAmount ?? 0;
      this.voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(0);
      });
      this.outBus.setFeedbackAmount(currAmount);
    } else if (mode === 'polyphonic') {
      const monoFx = this.outBus.getFeedback();
      const currAmount = monoFx.currentAmount;

      this.outBus.setFeedbackAmount(0);

      this.voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(currAmount);
      });
    } else {
      console.info('Feedback mode set to double-trouble, radical!');
    }
  }

  setFeedbackPitchScale(value: number) {
    this.outBus.setFeedbackPitchScale(value);

    this.voicePool.applyToAllVoices((voice) => {
      voice.feedback?.setDelayMultiplier(value);
    });
  }

  /* === I/O === */

  // async initMidiController(): Promise<boolean> {
  //   if (this.#midiController?.isInitialized) {
  //     return true;
  //   }

  //   if (!this.#midiController) {
  //     this.#midiController = new MidiController();
  //   }

  //   assert(
  //     this.#midiController,
  //     `SamplePlayer: Failed to create MIDI controller`
  //   );

  //   const result = await tryCatch(() => this.#midiController!.initialize());
  //   assert(!result.error, `SamplePlayer: Failed to initialize MIDI`);
  //   return result.data;
  // }

  // setMidiController(midiController: MidiController): this {
  //   this.#midiController = midiController;
  //   return this;
  // }

  // async enableMIDI(
  //   midiController?: MidiController,
  //   channel: number | 'all' = 'all'
  // ): Promise<this> {
  //   if (!midiController) {
  //     midiController = new MidiController();
  //     await midiController.initialize();
  //   }

  //   if (midiController.isInitialized) {
  //     this.#midiController = midiController;
  //     midiController.connectInstrument(this, channel);

  //     this.sendUpstreamMessage('midi:enabled', { channel });
  //   }
  //   return this;
  // }

  // disableMIDI(
  //   midiController?: MidiController,
  //   channel: number | 'all' = 'all'
  // ): this {
  //   const controller = midiController || this.#midiController;
  //   controller?.disconnectInstrument(this, channel);
  //   if (controller === this.#midiController) {
  //     this.#midiController = null;
  //   }

  //   this.sendUpstreamMessage('midi:disabled', { channel });

  //   return this;
  // }

  // switchMIDIChannel(channel: number | 'all') {
  //   this.#midiController?.switchInstrumentChannel(this, channel);
  // }

  /* === PUBLIC GETTERS === */

  get mainOut() {
    return this.#masterOut;
  }

  get outputBus() {
    return this.outBus;
  }

  get sampleDuration(): number {
    return this.#bufferDuration;
  }

  get volume(): number {
    return this.#masterOut.gain.value;
  }

  set volume(value: number) {
    this.#masterOut.gain.setValueAtTime(value, this.context.currentTime);
  }

  get loopEnabled(): boolean {
    return this.#loopEnabled;
  }

  get holdEnabled(): boolean {
    return this.#holdEnabled;
  }

  get gainLFO() {
    return this.#gainLFO;
  }

  get pitchLFO() {
    return this.#pitchLFO;
  }

  get loopStart(): number {
    return this.#macroLoopStart.targetValue;
  }

  get loopEnd(): number {
    return this.#macroLoopEnd.targetValue;
  }

  get isLoaded() {
    return this.#isLoaded;
  }

  get audiobuffer() {
    return this.#audiobuffer;
  }

  /* === CLEANUP === */

  dispose(): void {
    try {
      this.releaseAll();

      // Clear sustained notes
      this.#sustainedNotes.clear();

      if (this.voicePool) {
        this.voicePool.dispose();
        this.voicePool = null as unknown as SampleVoicePool;
      }

      if (this.outBus) {
        this.outBus.dispose();
        this.outBus = null as unknown as InstrumentBus;
      }

      this.#macroLoopStart?.dispose();
      this.#macroLoopEnd?.dispose();
      this.#macroLoopStart = null as unknown as MacroParam;
      this.#macroLoopEnd = null as unknown as MacroParam;

      this.#gainLFO?.dispose();
      this.#pitchLFO?.dispose();

      this.disconnect();

      // Reset state variables
      this.#bufferDuration = 0;
      this.#initialized = false;
      this.#isLoaded = false;
      this.#zeroCrossings = [];
      this.#useZeroCrossings = false;
      this.#loopEnabled = false;

      unregisterNode(this.nodeId);
    } catch (error) {
      console.error(`Error disposing Sampler ${this.nodeId}:`, error);
    }
  }
}
