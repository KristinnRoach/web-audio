import { copyChannelData } from '@/utils/audiodata/copyChannelData';
// SamplePlayer.ts - Refactored with Composition Pattern

import { Message, MessageHandler } from '@/events';
import { trimAudioBuffer, type FadeMs } from '@/utils/audiodata/process/trimBuffer';
import { resampleAudioBuffer } from '@/utils/audiodata/convert/resampleAudioBuffer';
import { clamp, assert } from '@/utils';

import {
  preProcessAudioBuffer,
  resampleForPitch,
  PreProcessOptions,
  PreProcessResults,
} from '@/nodes/preprocessor/Preprocessor';

import { isValidAudioBuffer, isMidiValue } from '@/utils';
import { GainStages, type AudioInput } from '@/nodes/LibNode';

import {
  isValidSamplerParamValue,
  samplerParams,
  type SamplerParams,
  type SamplerParamKey,
  type SamplerParamDescriptor,
} from './sampler-params';

import { LFO } from '@/nodes/modulators/LFO/LFO';
import { createInstrumentBus, type InstrumentBus } from '@/nodes/master/createInstrumentBus';
import { BusNodeName } from '@/nodes/master/InstrumentBus';
import { VOICE_SUM_GAIN } from '@/nodes/master/defaults';
import { getDuration, setDuration } from '@/nodes/modulators/envelope';
import {
  assertValidEnvelopeConfig,
  cloneEnvelopeConfig,
  type EnvelopeConfig,
} from './envelope-config';
import type { AudioDestination } from '@/nodes/LibAudioNode';
import { registerNode, unregisterNode, NodeID } from '@/nodes/node-store';
import { createMessageBus, MessageBus } from '@/events';
import { CustomLibWaveform, WaveformOptions } from '@/utils/audiodata/generate/generateWaveform';
import { VoiceEffects, type SampleVoiceChainNode } from './VoiceEffects';
import type { SamplePlayerWorkletAudioParamKey } from '@/worklets/processors/play/sample-player-paramdescriptors';
import { detectPitchPeriods } from '@/utils/audiodata/pitchDetection/pitchPeriods';
import {
  SAMPLE_ENVELOPE_IDS,
  createDefaultSampleEnvelopeConfig,
  getSampleEnvelopeIds,
  getSampleEnvelopeProcessorTarget,
  resolveSampleEnvelopeForProcessor,
  type SampleEnvelopeId,
} from './sample-envelope-policy';

const GLIDE_TEMP_SCALAR = 8; // for easy fine-tuning while prototyping the glide feature

export type TimestretchMode = 'off' | 'period';
/** Experimental: for comparing source interpolation by ear, may be removed. */
export type InterpolationMode = 'linear' | 'hermite' | 'sinc';

/** The processor node for `voiceCount` voices: per voice, stereo audio then its filter envelope in cents (for lpf.detune). */
const createSampleWorklet = (context: BaseAudioContext, voiceCount: number) =>
  new AudioWorkletNode(context, 'sample-player-processor', {
    numberOfInputs: 0,
    numberOfOutputs: voiceCount * 2,
    outputChannelCount: Array.from({ length: voiceCount }, () => [2, 1]).flat(),
    processorOptions: { voiceCount },
  });

/** A processor voice as its reports leave it; `midiNote` is null while free and `triggerId` names its current note. */
type Voice = {
  midiNote: number | null;
  triggerId: number;
  effects: VoiceEffects;
};

/**
 * When noteOn retunes a playing voice instead of triggering a new one.
 * `pitchLoop` waits until the voice is looping a pitch-length loop.
 * `interval` is the inclusive range of signed semitones from the voice's current note.
 */
export type LegatoSettings = {
  mode: 'off' | 'always' | 'pitchLoop';
  interval?: readonly [min: number, max: number];
  /** `legato` glides only notes that retune a playing voice; `always` (default) also glides new notes from the last one played. */
  glide?: 'always' | 'legato';
};

export type SamplePlayerOptions = {
  context: BaseAudioContext;
  polyphony?: number;
  audio?: AudioInput;
  voiceSignalChain?: readonly SampleVoiceChainNode[];
};

export class SamplePlayer {
  public readonly nodeId: NodeID;
  readonly nodeType = 'sample-player' as const;
  readonly context: BaseAudioContext;
  #messages: MessageBus<Message>;

  #initialized = false;
  #disposed = false;
  #initPromise: Promise<void> | null = null;
  #isLoaded = false;
  private readonly envelopeConfigs = new Map<SampleEnvelopeId, EnvelopeConfig>();
  #polyphony: number;
  #voiceSignalChain?: readonly SampleVoiceChainNode[];
  #initialAudio: AudioInput | null = null;

  #connections = new Set<NodeID>();
  #incoming = new Set<NodeID>();

  #buffer: AudioBuffer | null = null;
  #bufferDuration: number = 0;

  #loopEnabled = false;
  #startFromLoop = false;
  #loopLocked = false;
  #holdEnabled = false;
  #holdLocked = false;
  #sustainPedalPressed = false;

  #masterOut: GainNode;

  #trimStart = 0;
  #trimEnd = 0;
  #loopStart = 0;
  #loopEnd = 0;
  #gainLFO: LFO | null = null;
  #pitchLFO: LFO | null = null;

  #transposeSemitones = 0;
  #fineTuneCents = 0;

  #glideTime: number = samplerParams.glide.defaultValue;
  #loopLengthGlide: number = samplerParams.loopLengthGlide.defaultValue;
  #loopPositionGlide: number = samplerParams.loopPositionGlide.defaultValue;
  #loopPitchPeriods = this.#getNotePeriodsInSeconds([0], 1, 5);
  #positionTracking = false;
  #keytrackLoopAmount: number = samplerParams.keytrackLoop.defaultValue;
  #numGrains: number = samplerParams.numGrains.defaultValue;
  #grainSize: number = samplerParams.grainSize.defaultValue;
  #grainOffset: number = samplerParams.grainOffset.defaultValue;
  #hpfCutoff: number = samplerParams.highpassFilter.defaultValue;
  #lpfCutoff: number = samplerParams.lowpassFilter.defaultValue;

  #syncGainLFOToMidiNote = false;
  #syncPitchLFOToMidiNote = false;
  /** Last played note, so synced LFOs follow a transpose/fineTune too. */
  #lastPlayedNote: number | null = null;

  #useZeroCrossings = true;
  #interpolationMode: InterpolationMode | null = null;
  #timestretchMode: TimestretchMode = 'off';
  #pitchPeriodsSent = false;
  #preprocessAudio = true;

  /** One processor renders every voice; each voice's effects take two of its outputs. */
  #worklet: AudioWorkletNode | null = null;
  #voices: Voice[] = [];
  #legato: LegatoSettings = { mode: 'off' };
  #noteId = 0;
  #flushId = 0;
  #pendingFlushes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  #pitchEnabled = true;
  #outBus!: InstrumentBus; // todo: fix use of '!'

  // ? move to input controller ?
  #sustainedNotes = new Map<number, number>();

  // Nodes on a closed context go silent without throwing
  #onContextStateChange = () => {
    if (this.context.state !== 'closed') return;
    // An offline context closes when its render finishes; that's expected
    const isOffline =
      typeof OfflineAudioContext !== 'undefined' && this.context instanceof OfflineAudioContext;
    if (!isOffline)
      console.warn(`[SamplePlayer ${this.nodeId}] AudioContext closed; player is silent.`);
    this.#sendUpstreamMessage('context:closed', {});
  };

  constructor(options: SamplePlayerOptions) {
    assert(options.context, '[SamplePlayer] Constructor requires an AudioContext in options');

    this.nodeId = registerNode('sample-player', this);
    this.context = options.context;
    this.#messages = createMessageBus<Message>(this.nodeId);
    this.context.addEventListener('statechange', this.#onContextStateChange);
    this.#masterOut = new GainNode(this.context, {
      gain: samplerParams.volume.defaultValue,
    });

    // Store configuration for async init
    this.#polyphony = options.polyphony ?? 16;
    this.#voiceSignalChain = options.voiceSignalChain ? [...options.voiceSignalChain] : undefined;
    this.#initialAudio = options.audio ?? null;
  }

  async init(): Promise<void> {
    this.#assertNotDisposed();
    if (this.#initialized) return; // todo: remove #initialized flag if redundant (since now using initPromise)
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      try {
        // Initialize child components first
        this.#outBus = await createInstrumentBus(this.context); // WIP
        if (this.#disposed) {
          this.#outBus.dispose();
          this.#outBus = null as unknown as InstrumentBus;
        }
        this.#assertNotDisposed();
        const worklet = createSampleWorklet(this.context, this.#polyphony);
        this.#worklet = worklet;
        // Pushed one by one, so a failed init can dispose the voices built before it.
        for (let voiceIndex = 0; voiceIndex < this.#polyphony; voiceIndex++) {
          this.#voices.push({
            midiNote: null,
            triggerId: 0,
            effects: new VoiceEffects(this.context, worklet, voiceIndex, this.#voiceSignalChain),
          });
        }
        worklet.port.onmessage = ({ data }) => this.#receive(data);

        this.#post({ type: 'pool:setLegato', value: this.#legato });
        this.#post({ type: 'pool:setPitchOffset', value: this.#pitchOffset });
        this.#voices.forEach((voice) => voice.effects.setPitchOffset(this.#pitchOffset, null));
        this.#outBus.setPitchOffset(this.#pitchOffset, null);
        this.#post({ type: 'pool:setPitchEnabled', value: this.#pitchEnabled });
        if (this.#interpolationMode !== null) {
          this.#post({ type: 'voice:setInterpolation', value: this.#interpolationMode });
        }
        // Processors persist the periods across sample loads, so they are sent once here.
        // Keeps any periods configured before init.
        this.#post({ type: 'voice:setLoopQuantizePeriods', value: this.#loopPitchPeriods });
        // Replay what was set before the worklet existed. Pitch periods follow the
        // first sample load, which sends them for 'period' mode.
        this.#post({ type: 'voice:setLoopEnabled', value: this.#loopEnabled });
        this.#post({ type: 'voice:setStartFromLoop', value: this.#startFromLoop });
        this.#post({ type: 'voice:setKeytrackLoopAmount', value: this.#keytrackLoopAmount });
        this.#post({ type: 'voice:setTimestretchMode', value: this.#timestretchMode });
        this.#post({ type: 'voice:setNumGrains', value: this.#numGrains });
        this.#post({ type: 'voice:setGrainSize', value: this.#grainSize });
        this.#post({ type: 'voice:setGrainOffset', value: this.#grainOffset });

        // Connect audio chain
        this.#connectAudioChain();
        this.#setupLFOs();

        // Load initial sample if provided
        if (this.#initialAudio) {
          const loaded = await this.loadAudio(this.#initialAudio, {
            skipPreProcessing: true, // Skip preprocessing for init sample (likely already processed)
          });
          if (!loaded) throw new Error('No usable initial audio');
        }

        this.#assertNotDisposed();
        this.#resetLoopRange();

        this.#initialized = true;
      } catch (error) {
        // A failed init (e.g. an undecodable sample) leaves nothing usable, so
        // release everything the constructor registered too.
        this.dispose();

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to initialize SamplePlayer: ${errorMessage}`);
      }
    })();
    return this.#initPromise;
  }

  #connectAudioChain() {
    this.#voices.forEach((voice) => voice.effects.connect(this.#outBus.input));
    this.#outBus.connect(this.#masterOut);
    this.#masterOut.connect(this.context.destination);
  }

  // === MESSAGING ===

  public onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  #sendUpstreamMessage(type: string, data: any): this {
    this.#messages.sendMessage(type, data);
    return this;
  }

  // === CONNECTIONS ===

  public connect(destination: AudioDestination): void {
    const target = 'input' in destination && destination.input ? destination.input : destination;

    this.#masterOut.connect(target as AudioNode);

    // Track the connection by NodeID if possible
    if ('nodeId' in destination && typeof destination.nodeId === 'string') {
      this.#connections.add(destination.nodeId);
      (destination as any).addIncoming?.(this.nodeId);
    }
  }

  public disconnect(destination?: AudioDestination): void {
    if (destination) {
      const target = 'input' in destination ? destination.input : destination;
      this.#masterOut.disconnect(target as AudioNode);
      if ('nodeId' in destination && typeof destination.nodeId === 'string') {
        this.#connections.delete(destination.nodeId);
        (destination as any).removeIncoming?.(this.nodeId);
      }
    } else {
      // Disconnect all
      this.#masterOut.disconnect();
      this.#connections.clear();
    }
  }

  private addIncoming(sourceId: NodeID): void {
    this.#incoming.add(sourceId);
  }

  private removeIncoming(sourceId: NodeID): void {
    this.#incoming.delete(sourceId);
  }

  private get connections() {
    return {
      outgoing: Array.from(this.#connections),
      incoming: Array.from(this.#incoming),
    };
  }

  // === CONVENIENCE GETTERS ===

  get input() {
    return this.#outBus.input;
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

  /** True once teardown starts; distinct from a player that has not initialized yet. */
  get disposed(): boolean {
    return this.#disposed;
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error('SamplePlayer is disposed');
  }

  /* === MESSAGES === */

  /** All player messages use the same FIFO port. */
  #post(message: object) {
    this.#worklet?.port.postMessage(message);
  }

  /**
   * Wait until the processor has handled all messages posted so far. Scheduled
   * notes are queued, not sounded. Await before resuming an offline render;
   * this does not wait for AudioParam automation or later main-thread effects.
   * Requires init(); disposal rejects pending flushes.
   */
  async flushMessages(): Promise<void> {
    this.#assertNotDisposed();
    if (!this.#initialized) throw new Error('SamplePlayer is not initialized');
    const id = ++this.#flushId;
    return new Promise<void>((resolve, reject) => {
      this.#pendingFlushes.set(id, { resolve, reject });
      this.#post({ type: 'flush', id });
    });
  }

  /**
   * Voice reports name their voice; `initialized`, `flushed` and `voice:loaded` are node-wide.
   * Voice records hold the last reported note. The audio thread owns voice state and
   * may be ahead of them; reports about an old note are dropped.
   */
  #receive(data: any) {
    const { type, voice: index, ...report } = data;
    if (type === 'initialized') return this.#onProcessorReady();
    if (type === 'flushed') {
      this.#pendingFlushes.get(report.id)?.resolve();
      this.#pendingFlushes.delete(report.id);
      return;
    }
    if (type === 'voice:loaded') {
      this.#onSampleLoaded();
      return this.#emitFrom(this.#voices[this.#voices.length - 1], 'sample:loaded', report);
    }
    const voice = this.#voices[index];
    const voiceId = voice.effects.nodeId;

    switch (type) {
      // The pool picked this voice on the audio thread; its effects follow from here.
      case 'voice:started': {
        // Stolen: the note it held ends without a report of its own.
        if (voice.midiNote !== null) this.#voiceStopped(voice);
        const { midiNote, velocity, timestamp, glideTime, glideFromNote, triggerId } = report;
        Object.assign(voice, { midiNote, triggerId });
        this.#followNote(report, false);
        this.#emitFrom(voice, type, {
          voiceId,
          midiNote,
          velocity,
          timestamp,
          glideFromNote,
          glideTime,
        });
        voice.effects.followNote(midiNote, { timestamp, glideTime, glideFromNote });
        return;
      }

      case 'voice:retuned':
        if (voice.midiNote === null) return;
        voice.midiNote = report.midiNote;
        voice.effects.followNote(report.midiNote, {
          timestamp: report.timestamp,
          glideTime: report.glideTime,
          retuned: true,
        });
        this.#followNote(report, true);
        return this.#emitFrom(voice, type, { voiceId, ...report });

      case 'voice:releasing':
        if (voice.midiNote === null) return;
        return this.#emitFrom(voice, type, { voiceId, midiNote: voice.midiNote });

      case 'voice:ended':
        if (voice.midiNote === null || report.triggerId !== voice.triggerId) return;
        return this.#voiceStopped(voice);

      case 'loop:range':
      case 'trim:range':
      case 'voice:position': {
        // Idle report: the steady loop for the next note, not a playing range.
        if (report.idle) return;
        if (voice.midiNote === null || report.triggerId !== voice.triggerId) return;
        const { triggerId: _, ...range } = report;
        return this.#emitFrom(voice, type, { voiceId, midiNote: voice.midiNote, ...range });
      }
    }
  }

  #voiceStopped(voice: Voice) {
    const { midiNote } = voice;
    voice.midiNote = null;
    this.#emitFrom(voice, 'voice:stopped', { voiceId: voice.effects.nodeId, midiNote });
  }

  /** Voice reports go out with the voice as sender. */
  #emitFrom(voice: Voice, type: string, data: object) {
    this.#messages.sendMessage(type, { senderId: voice.effects.nodeId, ...data });
  }

  #onSampleLoaded() {
    this.#isLoaded = true;

    // Rescale every shape to the new buffer and push it down. Voices come up on
    // their own defaults, so this is also what first puts them on the owned state -
    // without it the player and its voices would hold different shapes.
    SAMPLE_ENVELOPE_IDS.forEach((id) => {
      const { shape } = this.getEnvelope(id);
      this.updateEnvelope(id, {
        shape: { ...shape, points: setDuration(shape.points, this.#bufferDuration) },
      });
    });
  }

  #onProcessorReady() {
    // Fresh voices start on defaults, so hand them the owned state before they play.
    SAMPLE_ENVELOPE_IDS.forEach((id) => this.#postEnvelope(id, this.getEnvelope(id)));
    this.#post({ type: 'voice:setLoopLengthGlide', value: this.#loopLengthGlide });
    this.#post({ type: 'voice:setLoopPositionGlide', value: this.#loopPositionGlide });
    this.#post({ type: 'voice:reportPlayheadPosition', value: this.#positionTracking });
    this.#sendUpstreamMessage('sample-player:initialized', {});
  }

  // TODO: Check whether this is still needed after moving loop range to processor
  #resetLoopRange() {
    this.#loopStart = 0;
    this.#loopEnd = this.#bufferDuration;
    this.#setParams(
      { loopStart: this.#loopStart, loopEnd: this.#loopEnd },
      this.context.currentTime,
    );
    return this;
  }

  /* === LFOs === */

  setModulationDepth = (modType: 'AM' | 'FM', depth: number) =>
    this.#voices.forEach((v) => v.effects.setModulationDepth(modType, depth));

  setAMModOctaveOffset = (offset: number) =>
    this.#voices.forEach((v) => v.effects.setAMModOctaveOffset(offset, v.midiNote));

  setModulationWaveform(
    modType: 'AM' | 'FM' = 'AM',
    waveform: CustomLibWaveform | OscillatorType | PeriodicWave = 'triangle',
    customWaveOptions: WaveformOptions = {},
  ) {
    this.#voices.forEach((v) =>
      v.effects.setModulationWaveform(modType, waveform, customWaveOptions),
    );
  }

  syncLFOsToNoteFreq(lfoId: 'gain-lfo' | 'pitch-lfo', enabled: boolean) {
    if (lfoId === 'gain-lfo') {
      if (enabled === true) {
        this.#gainLFO?.storeCurrentValues();
      } else {
        const storedVals = this.#gainLFO?.getStoredValues();
        if (storedVals) this.#gainLFO?.setFrequency(storedVals.rate);
      }

      this.#syncGainLFOToMidiNote = enabled;
    }
    if (lfoId === 'pitch-lfo') {
      if (enabled === true) {
        this.#pitchLFO?.storeCurrentValues();
      } else {
        const storedVals = this.#pitchLFO?.getStoredValues();
        if (storedVals) this.#pitchLFO?.setFrequency(storedVals.rate);
      }

      this.#syncPitchLFOToMidiNote = enabled;
    }
  }

  #setupLFOs() {
    const gainLFO = new LFO(this.context);
    const pitchLFO = new LFO(this.context);
    gainLFO.setWaveform('colored-noise', { harmonics: 18, slope: -0.2 });
    // LFO runs noise at rate / harmonics: rate sets the fastest jitter,
    // harmonics / rate is how long before the pattern repeats.
    pitchLFO.setWaveform('colored-noise', { harmonics: 42, slope: -0.4 });
    // Other wave options: 'colored-noise', pitchLFO.getPitchWobbleWaveform()

    gainLFO.connect(this.#outBus.input.gain);

    const detune = this.#worklet?.parameters.get('detune');
    if (detune) pitchLFO.connect(detune);

    this.#gainLFO = gainLFO;
    this.#pitchLFO = pitchLFO;
  }

  /* === LOAD / RESET === */

  #isLoading = false;
  #cancelPendingLoad: ((error: Error) => void) | null = null;

  /** Replace the sample, converting it to the context's sample rate before preprocessing. */
  async loadAudio(
    audio: AudioInput,
    preprocessOptions?: Partial<PreProcessOptions>,
  ): Promise<AudioBuffer | null> {
    return this.#loadAudio(audio, preprocessOptions);
  }

  async #loadAudio(
    audio: AudioInput,
    preprocessOptions?: Partial<PreProcessOptions>,
    validatedCrop = false,
  ): Promise<AudioBuffer | null> {
    this.#assertNotDisposed();
    if (this.#isLoading) {
      throw new Error('A sample load is already in progress');
    }
    this.#isLoading = true;
    let unsubscribe: (() => void) | undefined;
    try {
      let buffer = audio;
      if (buffer instanceof ArrayBuffer) {
        // decodeAudioData detaches its input; keep callers' encoded data reusable.
        buffer = await this.context.decodeAudioData(buffer.slice(0));
        this.#assertNotDisposed();
      }
      if (!validatedCrop && !isValidAudioBuffer(buffer)) {
        console.error('Invalid AudioBuffer provided');
        return null;
      }
      buffer = await resampleAudioBuffer(buffer, this.context.sampleRate);
      this.#assertNotDisposed();
      let newZeroCrossings: number[] = [];
      if (this.#preprocessAudio) {
        const processed: PreProcessResults = await preProcessAudioBuffer(
          this.context,
          buffer,
          preprocessOptions,
        );
        buffer = processed.audiobuffer;
        if (this.#useZeroCrossings && processed.zeroCrossings) {
          newZeroCrossings = processed.zeroCrossings;
        }
      }
      this.#assertNotDisposed();
      if (buffer.sampleRate !== this.context.sampleRate) {
        console.warn(
          `Sample rate mismatch - buffer: ${buffer.sampleRate}, context: ${this.context.sampleRate}`,
        );
        return null;
      }

      // Clear and release only if all preprocessing succeeds. This also drops
      // notes scheduled on the old buffer.
      this.releaseAll();
      this.#isLoaded = false;
      this.#buffer = buffer;
      this.#bufferDuration = buffer.duration;

      const loadedPromise = new Promise<void>((resolve, reject) => {
        this.#cancelPendingLoad = reject;
        unsubscribe = this.#messages.onMessage('sample:loaded', () => {
          resolve();
        });
      });

      // One copy for the processor, which every voice plays from. Copied so the
      // caller's buffer is left alone in Brave.
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
        copyChannelData(buffer, i),
      );
      this.#post({ type: 'voice:setBuffer', buffer: channels, durationSeconds: buffer.duration });
      if (newZeroCrossings.length) {
        this.#post({ type: 'voice:setZeroCrossings', zeroCrossings: newZeroCrossings });
      }
      // Voices drop their periods with the old buffer, even when it is the same one again.
      this.#pitchPeriodsSent = false;
      this.#sendPitchPeriods();

      this.#resetLoopRange();
      // Trim edges are seconds: one left from the previous sample (or set while
      // none was loaded) would cut the new one short.
      this.setTrimRange(0, this.#bufferDuration);

      await loadedPromise;
      this.#assertNotDisposed();
      return buffer;
    } finally {
      unsubscribe?.();
      this.#cancelPendingLoad = null;
      this.#isLoading = false;
    }
  }

  /**
   * Replace the loaded sample with the region between its trim edges,
   * reloading it without re-running preprocessing.
   *
   * Edges may be in either order. Seconds are clamped to the buffer. Returns null if there is no sample
   * loaded, the bounds aren't finite, or the region is empty.
   */
  async cropSample(
    startSeconds = this.trimStart,
    endSeconds = this.trimEnd,
    fadeMs: FadeMs = { in: 'default', out: 'default' },
  ): Promise<AudioBuffer | null> {
    this.#assertNotDisposed();
    const buffer = this.audiobuffer;
    if (!buffer) return null;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      return null;
    }

    // Inverted points (reverse playback) crop the same region
    const lo = Math.min(startSeconds, endSeconds);
    const hi = Math.max(startSeconds, endSeconds);
    const startSample = Math.max(0, Math.floor(lo * buffer.sampleRate));
    const endSample = Math.min(buffer.length, Math.ceil(hi * buffer.sampleRate));

    if (endSample <= startSample) return null;

    const cropped = trimAudioBuffer(this.context, buffer, startSample, endSample, fadeMs);
    // Valid crops may be silent; skip the non-silent input check when reloading.
    return this.#loadAudio(cropped, { skipPreProcessing: true }, true);
  }

  /* === PLAYBACK === */

  /**
   * `secondsFromNow` schedules the note on the audio clock. Its voice is picked
   * when the note sounds, from whatever is playing then.
   */
  play(
    midiNote: number,
    velocity = 100,
    glideTime = this.getGlideTime(),
    secondsFromNow = 0,
  ): number | null {
    if (this.#disposed) return null;
    const safeVelocity = isMidiValue(velocity) ? velocity : 100;
    if (!isMidiValue(midiNote)) {
      console.warn(`Invalid midiNote: ${midiNote}`);
      return null;
    }

    if (!this.#voices.length || !this.#buffer) return null;
    // Voices are keyed by the played note so release() still finds them after
    // a transpose. The audio thread picks the voice when the note is due and
    // works out its rate and glide origin; the bus and note-tracking LFOs
    // follow its report (`voice:started` or `voice:retuned`) in #followNote.
    this.#post({
      type: 'pool:noteOn',
      triggerId: ++this.#noteId,
      timestamp: this.now + secondsFromNow,
      midiNote,
      velocity: safeVelocity,
      glideTime: glideTime / GLIDE_TEMP_SCALAR,
    });
    return midiNote;
  }

  /**
   * Hold and sustain apply when called, not when a scheduled release is due.
   * `secondsFromNow` is ignored while the sustain pedal holds the note.
   */
  release(midiNote: number, secondsFromNow = 0): this {
    if (this.#disposed) return this;
    if (this.holdEnabled || this.#holdLocked) return this;

    if (this.#sustainPedalPressed) {
      this.#sustainedNotes.set(midiNote, (this.#sustainedNotes.get(midiNote) ?? 0) + 1);
      return this;
    }

    // Remove from sustained notes if it was there
    this.#sustainedNotes.delete(midiNote);

    // A legato voice falling back to an earlier held note reports `voice:retuned`.
    this.#post({ type: 'pool:noteOff', midiNote, timestamp: this.now + secondsFromNow });
    return this;
  }

  releaseAll(): this {
    this.#sustainedNotes.clear();
    // Releases every held note and drops the ones still waiting to sound.
    this.#post({ type: 'pool:allNotesOff', timestamp: this.now });
    return this;
  }

  /* === PITCH === */

  /** Off plays every note at the sample's own pitch; the pitch envelope still bends it. */
  setPitchEnabled(enabled: boolean): this {
    this.#pitchEnabled = enabled;
    this.#post({ type: 'pool:setPitchEnabled', value: enabled });
    return this;
  }

  /** Semitones added to every played note: transpose plus fine tune. */
  get #pitchOffset() {
    return this.#transposeSemitones + this.#fineTuneCents / 100;
  }

  /** The bus and note-tracking LFOs follow each note the processor reports. */
  #followNote(report: any, retuned: boolean) {
    const { midiNote, timestamp, glideTime } = report;
    this.#lastPlayedNote = midiNote;
    this.#syncLFOsToNote(midiNote + this.#pitchOffset, Math.max(this.now, timestamp));
    this.#outBus.followNote(midiNote, { timestamp, glideTime, retuned });
  }

  #syncLFOsToNote(soundingNote: number, timestamp = this.now) {
    if (this.#syncGainLFOToMidiNote)
      this.#gainLFO?.setMusicalNote(soundingNote, { divisor: 4, timestamp });
    if (this.#syncPitchLFOToMidiNote) {
      this.#pitchLFO?.setMusicalNote(soundingNote, { divisor: 4, timestamp });
    }
  }

  #applyPitchOffset(): this {
    const offset = this.#pitchOffset;
    this.#post({ type: 'pool:setPitchOffset', value: offset });
    this.#voices.forEach((voice) => voice.effects.setPitchOffset(offset, voice.midiNote));
    if (this.#lastPlayedNote !== null) this.#syncLFOsToNote(this.#lastPlayedNote + offset);
    this.#outBus?.setPitchOffset(offset, this.#lastPlayedNote);
    return this;
  }

  /** Musical transposition. Sums with fineTune() into one offset that retunes held voices too. */
  transpose(semitones: number): this {
    if (!Number.isFinite(semitones)) return this;
    this.#transposeSemitones = semitones;
    return this.#applyPitchOffset();
  }

  /** Tuning correction in cents. Sums with transpose(). */
  fineTune(cents: number): this {
    if (!Number.isFinite(cents)) return this;
    this.#fineTuneCents = cents;
    return this.#applyPitchOffset();
  }

  /**
   * Bakes transpose() + fineTune() into the samples and zeroes both, so notes keep
   * their pitch but play from re-pitched audio. Reloads like cropSample(): held
   * notes stop, trim/loop reset to the full buffer and `sample:loaded` fires,
   * then `pitch:committed` once the offsets are updated.
   * Returns null if there is no sample or no offset to commit.
   */
  async commitPitch(): Promise<AudioBuffer | null> {
    this.#assertNotDisposed();
    const transpose = this.#transposeSemitones;
    const fineTune = this.#fineTuneCents;
    const semitones = this.#pitchOffset;
    if (!this.#buffer || semitones === 0) return null;
    const pitched = resampleForPitch(this.context, this.#buffer, semitones);
    const loaded = await this.#loadAudio(pitched, { skipPreProcessing: true }, true);
    this.#assertNotDisposed();
    if (!loaded) return null;
    // Subtract what was baked rather than zeroing, so a transpose() or
    // fineTune() made during the reload is kept.
    this.#transposeSemitones -= transpose;
    this.#fineTuneCents -= fineTune;
    this.#applyPitchOffset();
    this.#sendUpstreamMessage('pitch:committed', { semitones });
    return loaded;
  }

  get transposedBySemitones() {
    return this.#transposeSemitones;
  }

  get fineTuneCents() {
    return this.#fineTuneCents;
  }

  /** Periods (sec) of `scale` degrees (semitones above C) over an octave range, ascending. */
  #getNotePeriodsInSeconds(scale: number[], lowestOctave: number, highestOctave: number): number[] {
    const periods: number[] = [];
    for (let octave = lowestOctave; octave <= highestOctave; octave++) {
      for (const interval of scale) {
        const midi = (octave + 1) * 12 + interval;
        periods.push(1 / (440 * 2 ** ((midi - 69) / 12)));
      }
    }
    return periods.sort((a, b) => a - b);
  }

  /**
   * Quantizes audio-rate loop periods to pitches of this scale. Pitches follow the
   * played midi-note like unlooped playback: with `scale: [0]`, a quantized
   * loop matches the midi-note's relative pitch in an octave within the given octave range.
   */
  setLoopPitchQuantization({
    scale = [0],
    lowestOctave = 1,
    highestOctave = 5,
  }: {
    scale?: number[];
    highestOctave?: number;
    lowestOctave?: number;
  } = {}) {
    this.#validateLoopPitchQuantization({ scale, lowestOctave, highestOctave });
    const periods = this.#getNotePeriodsInSeconds(scale, lowestOctave, highestOctave);
    this.#loopPitchPeriods = periods;

    this.#post({ type: 'voice:setLoopQuantizePeriods', value: periods });

    return this;
  }

  /**
   * Configured pitch-loop periods in seconds, shortest first, before playback-rate
   * transposition. Returns a copy. Use with setLoopDuration() to select a pitch loop;
   * longer durations continue to use the normal time-loop behavior.
   */
  getLoopPitchPeriods(): number[] {
    return [...this.#loopPitchPeriods];
  }

  #validateLoopPitchQuantization({
    scale,
    lowestOctave,
    highestOctave,
  }: Required<NonNullable<Parameters<SamplePlayer['setLoopPitchQuantization']>[0]>>) {
    if (scale.length === 0) {
      throw new RangeError('Scale must contain at least one note');
    }
    if (!scale.every(Number.isFinite)) {
      throw new RangeError(`Scale notes must be finite, got [${scale.join(', ')}]`);
    }
    if (!Number.isInteger(lowestOctave) || !Number.isInteger(highestOctave)) {
      throw new RangeError(`Octaves must be integers, got ${lowestOctave} to ${highestOctave}`);
    }
    if (lowestOctave > highestOctave) {
      throw new RangeError(`lowestOctave ${lowestOctave} is above highestOctave ${highestOctave}`);
    }
    if (highestOctave > 9) {
      throw new RangeError(`highestOctave must be at most 9, got ${highestOctave}`);
    }
  }

  /** PARAM SETTERS  */

  setVolume(volume: number): this {
    volume = clamp(volume, 0, 1);
    this.#masterOut.gain.setTargetAtTime(volume, this.context.currentTime, 0.005); // todo: standardize on a constant instead of hardcoding 0.005
    return this;
  }

  setTrimStart(seconds: number): this {
    return this.#setTrimEdge('start', seconds);
  }

  setTrimEnd(seconds: number): this {
    return this.#setTrimEdge('end', seconds);
  }

  #setTrimEdge(trimEdge: 'start' | 'end', seconds: number): this {
    seconds = clamp(seconds, 0, this.#bufferDuration);
    if (trimEdge === 'start') {
      if (seconds === this.trimStart) return this;
      this.#setParam('trimStart', seconds);
      this.#trimStart = seconds;
    } else {
      if (seconds === this.trimEnd) return this;
      this.#setParam('trimEnd', seconds);
      this.#trimEnd = seconds;
    }
    return this;
  }

  /** Set both trim edges at once so both land at one event time. */
  setTrimRange(startSeconds: number, endSeconds: number): this {
    const trimStart = clamp(startSeconds, 0, this.#bufferDuration);
    const trimEnd = clamp(endSeconds, 0, this.#bufferDuration);
    if (trimStart === this.trimStart && trimEnd === this.trimEnd) return this;

    this.#setParams({ trimStart, trimEnd });
    this.#trimStart = trimStart;
    this.#trimEnd = trimEnd;
    return this;
  }

  /** Sets one of the processor's AudioParams, which every voice reads. */
  #setParam(name: SamplePlayerWorkletAudioParamKey, targetValue: number, timestamp?: number) {
    this.#setParams({ [name]: targetValue }, timestamp);
  }

  /** Schedules processor AudioParams at one event time so paired updates don't split across frames. */
  #setParams(
    values: Partial<Record<SamplePlayerWorkletAudioParamKey, number>>,
    timestamp?: number,
  ) {
    // Validate first so a bad value can't leave a pair half-scheduled.
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && !Number.isFinite(value)) {
        throw new RangeError(`${name} must be a finite number, got ${value}`);
      }
    }
    const params = this.#worklet?.parameters;
    if (!params) return;
    const now = this.now;
    const cancelAt = timestamp ?? now;
    const at = Math.max(cancelAt, now + 0.001);
    for (const [name, value] of Object.entries(values)) {
      const param = params.get(name);
      if (!param || value === undefined) continue;
      param.cancelScheduledValues(cancelAt);
      param.setValueAtTime(value, at);
    }
  }

  /** Posts `voice:position` (fraction of the sample, can pass 1; ~60 Hz) per sounding voice. Off by default. */
  enablePositionTracking(enabled: boolean): this {
    this.#positionTracking = enabled;
    this.#post({ type: 'voice:reportPlayheadPosition', value: enabled });
    return this;
  }

  /** Length glide time constant between quantized loop periods. 0 = stepped. */
  setLoopLengthGlide(seconds: number): this {
    this.#loopLengthGlide = seconds;
    this.#post({ type: 'voice:setLoopLengthGlide', value: seconds });
    return this;
  }

  /**
   * Position glide time constant for quantized audio-rate loops. 0 = instant.
   * Tape-like: the pitch bends while the loop moves.
   */
  setLoopPositionGlide(seconds: number): this {
    this.#loopPositionGlide = seconds;
    this.#post({ type: 'voice:setLoopPositionGlide', value: seconds });
    return this;
  }

  setGlideTime(seconds: number): this {
    this.#glideTime = seconds;
    return this;
  }

  /** Retune a playing voice instead of retriggering; `{ mode: 'off' }` restores normal triggering. */
  setLegato(settings: LegatoSettings): this {
    this.#legato = { ...settings };
    this.#post({ type: 'pool:setLegato', value: this.#legato });
    return this;
  }

  setLoopEnabled(enabled: boolean): this {
    // if loop is locked (ON), turning it off is disabled but turning it on should work
    if (this.#loopLocked && !enabled) return this;

    this.#post({ type: 'voice:setLoopEnabled', value: enabled });
    if (this.#loopEnabled === enabled) return this;
    this.#loopEnabled = enabled;

    this.#sendUpstreamMessage('loop:enabled', { enabled });
    return this;
  }

  setLoopLocked(locked: boolean): this {
    if (this.#loopLocked === locked) return this;

    this.#loopLocked = locked;
    this.setLoopEnabled(locked);

    this.#sendUpstreamMessage('loop:locked', { locked });
    return this;
  }

  setHoldEnabled(enabled: boolean) {
    if (this.#holdEnabled === enabled) return this;
    if (this.#holdLocked && !enabled) return this;

    this.#holdEnabled = enabled;
    if (!enabled) this.releaseAll();
    this.#sendUpstreamMessage('hold:enabled', { enabled });
    return this;
  }

  setHoldLocked(locked: boolean): this {
    if (this.#holdLocked === locked) return this;

    this.#holdLocked = locked;
    if (locked === false) this.releaseAll();

    this.#sendUpstreamMessage('hold:locked', { locked });
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

    if (!pressed) {
      // release() mutates the queue and respects explicit hold/hold-lock.
      const deferred = [...this.#sustainedNotes];
      this.#sustainedNotes.clear();
      for (const [note, count] of deferred) {
        for (let i = 0; i < count; i++) this.release(note);
      }
    }

    return this;
  }

  setPlaybackDirection(direction: 'forward' | 'reverse'): this {
    this.#post({ type: 'voice:setPlaybackDirection', playbackDirection: direction });
    return this;
  }

  /**
   * Ping-pong loops turn around at both loop edges instead of jumping back, so
   * loop edge order no longer matters. Without it, loop edges set in reverse
   * order (start after end) make a reverse loop: the voice plays through the
   * loop once, then cycles it in reverse. A short pitched loop played ping-pong
   * sounds an octave lower, since one cycle covers the loop twice.
   */
  setLoopPingPong(enabled: boolean): this {
    this.#post({ type: 'voice:setLoopPingPong', value: enabled });
    return this;
  }

  /**
   * When enabled, notes start at the loop instead of the trim start while looping:
   * at the lower loop edge, or the higher one when playing in reverse. Trim
   * still bounds playback. With looping off, notes start at trim as usual.
   */
  setStartFromLoop(enabled: boolean): this {
    this.#startFromLoop = enabled;
    this.#post({ type: 'voice:setStartFromLoop', value: enabled });
    return this;
  }

  setLoopDurationDriftAmount(amount: number): this {
    this.#setParam('loopDurationDriftAmount', amount);
    return this;
  }

  setPanDriftEnabled = (enabled: boolean) => {
    this.#post({ type: 'voice:setPanDriftEnabled', value: enabled });
    return this;
  };

  setTimestretchMode = (mode: TimestretchMode) => {
    this.#timestretchMode = mode;
    this.#sendPitchPeriods();
    this.#post({ type: 'voice:setTimestretchMode', value: mode });
    return this;
  };

  /** Experimental: for comparing source interpolation by ear, may be removed. */
  setInterpolation = (mode: InterpolationMode) => {
    if (mode !== 'linear' && mode !== 'hermite' && mode !== 'sinc') {
      throw new RangeError('Interpolation mode must be linear, hermite or sinc');
    }
    this.#interpolationMode = mode;
    this.#post({ type: 'voice:setInterpolation', value: mode });
    return this;
  };

  // Only 'period' needs them, and detection blocks, so nothing pays for it until then.
  #sendPitchPeriods() {
    const buffer = this.#buffer;
    if (this.#timestretchMode !== 'period' || !buffer || this.#pitchPeriodsSent) return;
    const { periods, hopSamples } = detectPitchPeriods(
      copyChannelData(buffer, 0),
      buffer.sampleRate,
    );
    this.#post({ type: 'voice:setPitchPeriods', periods, hopSamples });
    this.#pitchPeriodsSent = true;
  }

  setLoopStart = (seconds: number) => {
    return this.#setLoopEdge('start', seconds, this.loopEnd);
  };

  setLoopEnd = (seconds: number) => {
    return this.#setLoopEdge('end', this.loopStart, seconds);
  };

  setLoopDuration = (seconds: number) =>
    this.#setLoopEdge('end', this.loopStart, this.loopStart + seconds);

  // Keytrack loop length to the played note (0 = fixed samples, 1 = constant loop time)
  setKeytrackLoopAmount(amount: number) {
    const clamped = Math.max(0, Math.min(1, amount));
    this.#keytrackLoopAmount = clamped;
    this.#post({ type: 'voice:setKeytrackLoopAmount', value: clamped });
    return this;
  }

  getKeytrackLoopAmount = () => this.#keytrackLoopAmount;

  /** Number of simultaneous grains per voice (1 = playhead only; >1 spawns finite grains). */
  setNumGrains(count: number): this {
    const clamped = Math.max(
      samplerParams.numGrains.min,
      Math.min(samplerParams.numGrains.max, Math.round(count)),
    );
    this.#numGrains = Number.isFinite(clamped) ? clamped : samplerParams.numGrains.defaultValue;
    this.#post({ type: 'voice:setNumGrains', value: this.#numGrains });
    return this;
  }

  getNumGrains = () => this.#numGrains;

  /** Spawned grain length in seconds. */
  setGrainSize(seconds: number): this {
    const { min, max, defaultValue } = samplerParams.grainSize;
    this.#grainSize = Number.isFinite(seconds)
      ? Math.max(min, Math.min(max, seconds))
      : defaultValue;
    this.#post({ type: 'voice:setGrainSize', value: this.#grainSize });
    return this;
  }

  getGrainSize = () => this.#grainSize;

  /** Spawned grain start offset depth in [0, 1]: 1 = up to ±500 ms from the playhead. */
  setGrainOffset(depth: number): this {
    const { defaultValue } = samplerParams.grainOffset;
    this.#grainOffset = Number.isFinite(depth) ? Math.max(0, Math.min(1, depth)) : defaultValue;
    this.#post({ type: 'voice:setGrainOffset', value: this.#grainOffset });
    return this;
  }

  getGrainOffset = () => this.#grainOffset;

  #setLoopEdge(loopEdge: 'start' | 'end', loopStartSeconds: number, loopEndSeconds: number) {
    // Each point is stored as given so the result doesn't depend on set order.
    // The processor resolves ordering, pitch quantization, zero-crossing snapping
    // and trim containment.
    const seconds = clamp(
      loopEdge === 'start' ? loopStartSeconds : loopEndSeconds,
      0,
      this.#bufferDuration,
    );
    const timestamp = this.context.currentTime;

    if (loopEdge === 'start') {
      if (seconds === this.loopStart) return this;
      this.#setParam('loopStart', seconds, timestamp);
      this.#loopStart = seconds;
    } else {
      if (seconds === this.loopEnd) return this;
      this.#setParam('loopEnd', seconds, timestamp);
      this.#loopEnd = seconds;
    }

    return this;
  }

  /** Set both loop edges at once: one voice update. */
  setLoopRange(loopStartSeconds: number, loopEndSeconds: number) {
    const loopStart = clamp(loopStartSeconds, 0, this.#bufferDuration);
    const loopEnd = clamp(loopEndSeconds, 0, this.#bufferDuration);
    if (loopStart === this.loopStart && loopEnd === this.loopEnd) return this;

    const timestamp = this.context.currentTime;
    this.#setParams({ loopStart, loopEnd }, timestamp);
    this.#loopStart = loopStart;
    this.#loopEnd = loopEnd;

    return this;
  }

  scrollLoopPosition(loopStart: number) {
    const loopDuration = this.loopEnd - this.loopStart;
    loopStart = clamp(
      loopStart,
      Math.max(0, -loopDuration),
      this.#bufferDuration - Math.max(0, loopDuration),
    );
    return this.setLoopRange(loopStart, loopStart + loopDuration);
  }

  applyParams(params: SamplerParams): this {
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

  getLoopLengthGlide(): number {
    return this.#loopLengthGlide;
  }

  getLoopPositionGlide(): number {
    return this.#loopPositionGlide;
  }

  getGlideTime(): number {
    return this.#glideTime;
  }

  getHpfCutoff = () => this.#hpfCutoff;
  getLpfCutoff = () => this.#lpfCutoff;

  /* === ENVELOPES === */

  /**
   * Returns a detached, serializable envelope config.
   *
   * SamplePlayer owns the editable config; voices receive snapshots to schedule from.
   */
  getEnvelope(id: SampleEnvelopeId): EnvelopeConfig {
    const stored = this.envelopeConfigs.get(id);
    if (stored) return cloneEnvelopeConfig(stored);

    const config = createDefaultSampleEnvelopeConfig(id, this.sampleDuration || 1);
    this.envelopeConfigs.set(id, config);
    return cloneEnvelopeConfig(config);
  }

  /** Shape length in seconds, before timeScale/rate sync; excludes sustain holds and loop repeats. */
  getEnvelopeDuration(id: SampleEnvelopeId): number {
    return getDuration(this.getEnvelope(id).shape.points);
  }

  /**
   * Merges `patch` into the current config and emits one `envelope:changed` message.
   * The merge is shallow: a `shape` in the patch replaces the whole shape.
   * `duration` proportionally scales the resulting shape's segments to seconds,
   * before playback timeScale/rate sync. It is not stored as a separate config field.
   * Alternatively, `durationRatio` scales to a positive multiple of the loaded sample's
   * duration (1 = full sample). Requires a loaded sample; cannot be combined with `duration`.
   * Updates follow the existing live-edit rules; sample loads still resize shapes.
   */
  updateEnvelope(
    id: SampleEnvelopeId,
    patch: Partial<EnvelopeConfig> & { duration?: number; durationRatio?: number },
  ): void {
    const { duration, durationRatio, ...configPatch } = patch;
    if (durationRatio !== undefined) {
      if (duration !== undefined) {
        throw new TypeError('Specify either duration or durationRatio');
      }
      if (!Number.isFinite(durationRatio) || durationRatio <= 0) {
        throw new RangeError('Envelope duration ratio must be finite and greater than zero');
      }
      if (this.sampleDuration <= 0) {
        throw new RangeError('Envelope duration ratio requires a loaded sample');
      }
    }
    const seconds = durationRatio === undefined ? duration : durationRatio * this.sampleDuration;
    const merged = { ...this.getEnvelope(id), ...configPatch };
    assertValidEnvelopeConfig(merged);
    if (seconds !== undefined) {
      merged.shape = { ...merged.shape, points: setDuration(merged.shape.points, seconds) };
      assertValidEnvelopeConfig(merged);
    }

    const next = cloneEnvelopeConfig(merged);
    this.envelopeConfigs.set(id, next);

    this.#postEnvelope(id, next);

    this.#sendUpstreamMessage('envelope:changed', { id, config: cloneEnvelopeConfig(next) });
  }

  /** Restores one envelope, or all when `id` is omitted, to defaults sized to the current sample. */
  resetEnvelope(id?: SampleEnvelopeId): void {
    (id ? [id] : SAMPLE_ENVELOPE_IDS).forEach((envId) =>
      this.updateEnvelope(
        envId,
        createDefaultSampleEnvelopeConfig(envId, this.sampleDuration || 1),
      ),
    );
  }

  /** The processor applies a new shape at its next point. */
  #postEnvelope(id: SampleEnvelopeId, config: EnvelopeConfig) {
    if (!this.envelopeIds.includes(id)) return;
    this.#post({
      type: 'voice:setEnvelope',
      target: getSampleEnvelopeProcessorTarget(id),
      value: config.enabled ? resolveSampleEnvelopeForProcessor(id, config) : null,
    });
  }

  /** Envelope ids on the current voices; empty until the player is initialized. The filter one needs an lpf. */
  get envelopeIds(): readonly SampleEnvelopeId[] {
    const effects = this.#voices[0]?.effects;
    return effects ? getSampleEnvelopeIds(effects.getParam('lpf') !== null) : [];
  }

  /**
   * Named tap points covering the whole instrument, from inside the voices
   * through the bus to master out.
   * Pass to `monitorLevels` from `@kidlib/web-audio/debug`.
   */
  getGainStages({ includeVoices = true } = {}): GainStages {
    const busStages = Object.entries(this.#outBus.getGainStages()).map(([name, node]) => [
      `bus.${name}`,
      node,
    ]);
    // Each voice stage, prefixed `voice.`, is metered as the sum across every voice:
    // it reads whatever is playing without depending on which voice was picked.
    const perVoice = includeVoices
      ? this.#voices.map((voice) => voice.effects.getGainStages())
      : [];
    const voiceStages = Object.keys(perVoice[0] ?? {}).map((name) => [
      `voice.${name}`,
      perVoice.map((stages) => stages[name]),
    ]);
    return {
      ...Object.fromEntries(voiceStages),
      ...Object.fromEntries(busStages),
      masterOut: this.#masterOut,
    };
  }

  /* === FX === */

  setDistortionMacro(amount: number): void {
    this.#outBus.setDistortionMacro(amount);
  }

  setDrive(amount: number): void {
    this.#outBus.setDrive(amount);
  }

  setClippingMacro(amount: number): void {
    this.#outBus.setClippingMacro(amount);
  }

  setDelayTime(seconds: number): void {
    this.#outBus.setDelayTime(seconds);
  }

  setDelayFeedback(amount: number): void {
    this.#outBus.setDelayFeedback(amount);
  }

  setDryWetMix = (mix: { dry: number; wet: number }) => {
    this.#outBus.setDryWetMix(mix);
  };

  sendToFx = (effect: BusNodeName, amount: number) => {
    this.#outBus.setSendAmount(effect, amount);
  };

  setLpfCutoff = (hz: number, preOrPostFx: 'pre' | 'post' | 'all' = 'pre') => {
    this.#lpfCutoff = hz;
    if (preOrPostFx === 'pre' || preOrPostFx === 'all') {
      this.#voices.forEach((v) => v.effects.setLpfCutoff(hz));
    }
    if (preOrPostFx === 'post' || preOrPostFx === 'all') {
      this.#outBus.setLpfCutoff(hz);
    }
  };

  setHpfCutoff = (hz: number, preOrPostFx: 'pre' | 'post' = 'post') => {
    this.#hpfCutoff = hz;
    if (preOrPostFx === 'pre') {
      this.#voices.forEach((v) => v.effects.setHpfCutoff(hz));
    } else if (preOrPostFx === 'post') {
      this.#outBus.setHpfCutoff(hz);
    }
  };

  setReverbAmount = (amount: number) => {
    this.#outBus.setReverbSize(amount);
  };

  setFeedbackDecay(value: number) {
    this.#outBus.setFeedbackDecay(value);
    this.#voices.forEach((voice) => {
      voice.effects.feedback?.setDecay(value);
    });
  }

  setFeedbackLowpassCutoff(freqHz: number) {
    this.#outBus.setFeedbackLowpassCutoff(freqHz);

    this.#voices.forEach((voice) => {
      voice.effects.feedback?.setLowpassCutoff(freqHz);
    });
  }

  // === FEEDBACK ===

  setFeedbackAmount = (amount: number) => {
    amount = clamp(amount, 0, 1);
    if (this.#feedbackMode === 'monophonic' || this.#feedbackMode === 'double-trouble') {
      this.#outBus.setFeedbackAmount(amount);
    }

    if (this.#feedbackMode === 'polyphonic' || this.#feedbackMode === 'double-trouble') {
      this.#voices.forEach((voice) => {
        voice.effects.feedback?.setAmountMacro(amount);
      });
    }
  };

  #feedbackMode: 'monophonic' | 'polyphonic' | 'double-trouble' = 'monophonic';

  setFeedbackMode(mode: 'monophonic' | 'polyphonic' | 'double-trouble') {
    this.#feedbackMode = mode;

    if (mode === 'monophonic') {
      let currAmount = this.#voices[0].effects.feedback?.currentAmount ?? 0;
      this.#voices.forEach((voice) => {
        voice.effects.feedback?.setAmountMacro(0);
      });
      this.#outBus.setFeedbackAmount(currAmount);
    } else if (mode === 'polyphonic') {
      const monoFx = this.#outBus.getFeedback();
      const currAmount = monoFx.currentAmount;

      this.#outBus.setFeedbackAmount(0);

      this.#voices.forEach((voice) => {
        voice.effects.feedback?.setAmountMacro(currAmount);
      });
    }
  }

  setFeedbackPitchScale(value: number) {
    this.#outBus.setFeedbackPitchScale(value);

    this.#voices.forEach((voice) => {
      voice.effects.feedback?.setDelayMultiplier(value);
    });
  }

  /* === PUBLIC GETTERS === */

  get sampleDuration(): number {
    return this.#bufferDuration;
  }

  get volume(): number {
    return this.#masterOut.gain.value;
  }

  set volume(value: number) {
    this.#masterOut.gain.setTargetAtTime(value, this.context.currentTime, 0.005);
  }

  get loopEnabled(): boolean {
    return this.#loopEnabled;
  }

  get holdEnabled(): boolean {
    return this.#holdEnabled;
  }

  /** Set the amplitude LFO rate in Hz. */
  setGainLFOFrequency(hz: number): void {
    this.#gainLFO?.setFrequency(hz);
  }

  setGainLFODepth(depth: number): void {
    // Dips below the bus input's headroom gain instead of boosting above it.
    const safeDepth = clamp(depth, 0, 1);
    this.#outBus?.input.gain.setValueAtTime(VOICE_SUM_GAIN * (1 - safeDepth / 2), this.now);
    this.#gainLFO?.setDepth((VOICE_SUM_GAIN * safeDepth) / 2);
  }

  /** Set the pitch LFO rate in Hz. */
  setPitchLFOFrequency(hz: number): void {
    this.#pitchLFO?.setFrequency(hz);
  }

  /** Modulates voice detune; depth is in cents. */
  setPitchLFODepth(cents: number): void {
    this.#pitchLFO?.setDepth(cents);
  }

  get trimStart(): number {
    return this.#trimStart;
  }

  get trimEnd(): number {
    return this.#trimEnd;
  }

  /** Whether notes start at the loop instead of the trim start while looping is on. */
  get startFromLoop(): boolean {
    return this.#startFromLoop;
  }

  get loopStart(): number {
    return this.#loopStart;
  }

  get loopEnd(): number {
    return this.#loopEnd;
  }

  get isLoaded() {
    return this.#isLoaded;
  }

  get audiobuffer() {
    return this.#buffer;
  }

  /* === CLEANUP === */

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelPendingLoad?.(new Error('SamplePlayer is disposed'));
    for (const pending of this.#pendingFlushes.values()) {
      pending.reject(new Error('SamplePlayer is disposed'));
    }
    this.#pendingFlushes.clear();
    try {
      this.context.removeEventListener('statechange', this.#onContextStateChange);
      this.releaseAll();

      // Clear sustained notes
      this.#sustainedNotes.clear();

      for (const voice of this.#voices) {
        if (voice.midiNote !== null) this.#voiceStopped(voice);
        voice.effects.dispose();
      }
      this.#voices = [];
      this.#worklet?.port.close();
      this.#worklet = null;

      if (this.#outBus) {
        this.#outBus.dispose();
        this.#outBus = null as unknown as InstrumentBus;
      }

      this.#gainLFO?.dispose();
      this.#pitchLFO?.dispose();

      this.disconnect();

      // Reset state variables
      this.#bufferDuration = 0;
      this.#buffer = null;
      this.#initialized = false;
      this.#isLoaded = false;
      this.#useZeroCrossings = false;
      this.#loopEnabled = false;

      unregisterNode(this.nodeId);
    } catch (error) {
      console.error(`Error disposing Sampler ${this.nodeId}:`, error);
    }
  }
}
