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
import { SampleVoicePool, type LegatoSettings } from './SampleVoicePool';
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
import { createSampleVoicePool } from './createSampleVoicePool';
import type { InterpolationMode, SampleVoiceChainNode, TimestretchMode } from './SampleVoice';
import { detectPitchPeriods } from '@/utils/audiodata/pitchDetection/pitchPeriods';
import {
  SAMPLE_ENVELOPE_IDS,
  createDefaultSampleEnvelopeConfig,
  type SampleEnvelopeId,
} from './sample-envelope-policy';

const GLIDE_TEMP_SCALAR = 8; // for easy fine-tuning while prototyping the glide feature

export type SamplePlayerOptions = {
  context: AudioContext;
  polyphony?: number;
  audio?: AudioInput;
  voiceSignalChain?: readonly SampleVoiceChainNode[];
};

export class SamplePlayer {
  public readonly nodeId: NodeID;
  readonly nodeType = 'sample-player' as const;
  readonly context: AudioContext;
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
  #loopLocked = false;
  #holdEnabled = false;
  #holdLocked = false;
  #sustainPedalPressed = false;

  #masterOut: GainNode;

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

  #voicePool!: SampleVoicePool; // todo: fix use of '!'
  #outBus!: InstrumentBus; // todo: fix use of '!'

  // ? move to input controller ?
  #sustainedNotes = new Map<MidiValue, number>();

  // Nodes on a closed context go silent without throwing
  #onContextStateChange = () => {
    if (this.context.state !== 'closed') return;
    console.warn(`[SamplePlayer ${this.nodeId}] AudioContext closed; player is silent.`);
    this.#sendUpstreamMessage('context:closed', {});
  };

  constructor(options: SamplePlayerOptions) {
    assert(options.context, '[SamplePlayer] Constructor requires an AudioContext in options');

    this.nodeId = registerNode('sample-player', this);
    this.context = options.context;
    this.#messages = createMessageBus<Message>(this.nodeId);
    this.context.addEventListener('statechange', this.#onContextStateChange);
    this.#masterOut = new GainNode(this.context, { gain: 0.5 });

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
        this.#voicePool = await createSampleVoicePool(
          this.context,
          this.#polyphony,
          this.#voiceSignalChain,
        );
        if (this.#disposed) {
          this.#voicePool.dispose();
          this.#voicePool = null as unknown as SampleVoicePool;
        }
        this.#assertNotDisposed();
        const interpolationMode = this.#interpolationMode;
        if (interpolationMode !== null) {
          this.#voicePool.applyToAllVoices((voice) => voice.setInterpolation(interpolationMode));
        }
        // Processors persist the periods across sample loads, so they are sent once here.
        // Keeps any periods configured before init.
        const periods = this.#loopPitchPeriods;
        this.#voicePool.applyToAllVoices((voice) => {
          voice.sendToProcessor({ type: 'setLoopQuantizePeriods', value: periods });
        });

        // Connect audio chain
        this.#connectAudioChain();
        this.#setupLFOs();
        this.#setupMessageHandling();

        // Load initial sample if provided
        if (this.#initialAudio) {
          const loaded = await this.loadAudio(this.#initialAudio, {
            skipPreProcessing: true, // Skip preprocessing for init sample (likely already processed)
          });
          if (!loaded) throw new Error('No usable initial audio');
        }

        this.#assertNotDisposed();
        this.#resetLoopPoints();

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
    this.#voicePool.connect(this.#outBus.input);
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

  #setupMessageHandling(): this {
    this.#voicePool.onMessage('sample:loaded', () => {
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
    });

    this.#voicePool.onMessage('voice-pool:initialized', () => {
      // Fresh voices start on defaults, so hand them the owned state before they play.
      SAMPLE_ENVELOPE_IDS.forEach((id) => {
        const config = this.getEnvelope(id);
        this.#voicePool.applyToAllVoices((voice) => voice.setEnvelopeConfig(id, config));
      });
      this.#voicePool.applyToAllVoices((voice) => voice.setLoopLengthGlide(this.#loopLengthGlide));
      this.#voicePool.applyToAllVoices((voice) =>
        voice.setLoopPositionGlide(this.#loopPositionGlide),
      );
      this.#voicePool.applyToAllVoices((voice) =>
        voice.enablePositionTracking(this.#positionTracking),
      );
      this.#sendUpstreamMessage('sample-player:initialized', {});
    });

    // Forward voice pool messages upstream
    this.#messages.forwardFrom(this.#voicePool, [
      'voice-pool:initialized',
      'voice:started',
      'voice:stopped',
      'voice:releasing',
      'sample:loaded',
      // Resolved loop and trim in seconds, from whichever voice resolved them last.
      'loop:range',
      'trim:range',
      // Playhead per voice (0..1 of the sample), only while position tracking is on.
      'voice:position',
    ]);
    return this;
  }

  // TODO: Check whether this is still needed after moving loop points to processor
  #resetLoopPoints() {
    this.#loopStart = 0;
    this.#loopEnd = this.#bufferDuration;
    const timestamp = this.context.currentTime;
    this.#voicePool.applyToAllVoices((voice) =>
      voice.setLoopPoints(this.#loopStart, this.#loopEnd, timestamp),
    );
    return this;
  }

  /* === LFOs === */

  setModulationDepth = (modType: 'AM' | 'FM', depth: number) =>
    this.#voicePool.applyToAllVoices((v) => v.setModulationDepth(modType, depth));

  setAMModOctaveOffset = (offset: number) =>
    this.#voicePool.applyToAllVoices((v) => v.setAMModOctaveOffset(offset));

  setModulationWaveform(
    modType: 'AM' | 'FM' = 'AM',
    waveform: CustomLibWaveform | OscillatorType | PeriodicWave = 'triangle',
    customWaveOptions: WaveformOptions = {},
  ) {
    this.#voicePool.applyToAllVoices((v) =>
      v.setModulationWaveform(modType, waveform, customWaveOptions),
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

    this.#voicePool.applyToAllVoices((voice) => {
      const param = voice.getParam('detune');
      if (param) pitchLFO.connect(param);
    });

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

      // Clear and release only if all preprocessing succeeds.
      this.releaseAll();
      this.#isLoaded = false;
      this.#buffer = buffer;
      this.#bufferDuration = buffer.duration;

      const loadedPromise = new Promise<void>((resolve, reject) => {
        this.#cancelPendingLoad = reject;
        unsubscribe = this.#voicePool.onMessage('sample:loaded', () => {
          resolve();
        });
      });

      this.#voicePool.setBuffer(buffer, newZeroCrossings);
      // Voices drop their periods with the old buffer, even when it is the same one again.
      this.#pitchPeriodsSent = false;
      this.#sendPitchPeriods();

      this.#resetLoopPoints();
      // Trim points are seconds: one left from the previous sample (or set while
      // none was loaded) would cut the new one short.
      this.setSampleStartPoint(0);
      this.setSampleEndPoint(this.#bufferDuration);

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
   * Replace the loaded sample with the region between its start and end points,
   * reloading it without re-running preprocessing.
   *
   * Points may be in either order. Seconds are clamped to the buffer. Returns null if there is no sample
   * loaded, the bounds aren't finite, or the region is empty.
   */
  async cropSample(
    startSeconds = this.getStartPoint(),
    endSeconds = this.getEndPoint(),
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
   * `secondsFromNow` schedules the note on the audio clock. The voice is
   * allocated now, so a scheduled note counts toward polyphony straight away.
   */
  play(
    midiNote: MidiValue,
    velocity: MidiValue = 100,
    glideTime = this.getGlideTime(),
    secondsFromNow = 0,
  ): MidiValue | null {
    if (this.#disposed) return null;
    const safeVelocity = isMidiValue(velocity) ? velocity : 100;
    if (!isMidiValue(midiNote)) {
      console.warn(`Invalid midiNote: ${midiNote}`);
      return null;
    }
    // Voices are keyed by the played note so release() still finds them after
    // a transpose; anything that tracks pitch gets the sounding note.
    const soundingNote = midiNote + this.#pitchOffset;
    this.#lastPlayedNote = midiNote;
    this.#syncLFOsToNote(soundingNote);

    const played = this.#voicePool.noteOn(
      midiNote,
      safeVelocity,
      secondsFromNow,
      glideTime / GLIDE_TEMP_SCALAR,
    );
    if (!played) return null;
    // The bus follows the pool: same glide, and a legato retune doesn't restart its decay.
    this.#outBus.noteOn(
      soundingNote,
      safeVelocity,
      secondsFromNow,
      played.glideTime,
      played.retuned,
    );
    return played.midiNote;
  }

  /** `secondsFromNow` is ignored while the sustain pedal holds the note. */
  release(midiNote: MidiValue, secondsFromNow = 0): this {
    if (this.#disposed) return this;
    if (this.holdEnabled || this.#holdLocked) return this;

    if (this.#sustainPedalPressed) {
      this.#sustainedNotes.set(midiNote, (this.#sustainedNotes.get(midiNote) ?? 0) + 1);
      return this;
    }

    // Remove from sustained notes if it was there
    this.#sustainedNotes.delete(midiNote);

    this.#followFallback(this.#voicePool.noteOff(midiNote, secondsFromNow), secondsFromNow);
    this.#outBus.noteOff(midiNote + this.#pitchOffset);
    this.#sendUpstreamMessage('note:off', { midiNote });
    return this;
  }

  releaseAll(): this {
    this.#sustainedNotes.clear();
    this.#voicePool?.allNotesOff();
    this.#outBus?.releaseAll();
    return this;
  }

  /* === PITCH === */

  setPitchEnabled(enabled: boolean): this {
    this.#voicePool.allVoices.forEach((v) => (enabled ? v.enablePitch() : v.disablePitch()));
    return this;
  }

  /** Semitones added to every played note: transpose plus fine tune. */
  get #pitchOffset() {
    return this.#transposeSemitones + this.#fineTuneCents / 100;
  }

  /** A legato voice returning to an earlier held note takes the note-tracking LFOs and bus feedback with it. */
  #followFallback(fallback: { midiNote: MidiValue; glideTime: number } | null, secondsFromNow = 0) {
    if (!fallback) return;
    const soundingNote = fallback.midiNote + this.#pitchOffset;
    this.#lastPlayedNote = fallback.midiNote;
    const timestamp = this.now + secondsFromNow;
    this.#syncLFOsToNote(soundingNote, timestamp);
    this.#outBus.getFeedback()?.setPitch(soundingNote, 0, timestamp, fallback.glideTime);
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
    this.#voicePool.applyToAllVoices((voice) => voice.setPitchOffset(offset));
    if (this.#lastPlayedNote !== null) {
      const soundingNote = this.#lastPlayedNote + offset;
      this.#syncLFOsToNote(soundingNote);
      this.#outBus.getFeedback()?.setPitch(soundingNote, 0, this.now, 0.01);
    }
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

    this.#voicePool?.applyToAllVoices((voice) => {
      voice.sendToProcessor({ type: 'setLoopQuantizePeriods', value: periods });
    });

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

  setSampleStartPoint(seconds: number): this {
    this.#voicePool.applyToAllVoices((voice) => voice.setParam('startPoint', seconds));
    return this;
  }

  setSampleEndPoint(seconds: number): this {
    this.#voicePool.applyToAllVoices((voice) => voice.setParam('endPoint', seconds));
    return this;
  }

  /** Posts `voice:position` (0..1 of the sample, ~60 Hz) per sounding voice. Off by default. */
  enablePositionTracking(enabled: boolean): this {
    this.#positionTracking = enabled;
    this.#voicePool?.applyToAllVoices((voice) => voice.enablePositionTracking(enabled));
    return this;
  }

  /** Length glide time constant between quantized loop periods. 0 = stepped. */
  setLoopLengthGlide(seconds: number): this {
    this.#loopLengthGlide = seconds;
    this.#voicePool?.applyToAllVoices((voice) => voice.setLoopLengthGlide(seconds));
    return this;
  }

  /** Position glide time constant for quantized audio-rate loops. 0 = instant. */
  setLoopPositionGlide(seconds: number): this {
    this.#loopPositionGlide = seconds;
    this.#voicePool?.applyToAllVoices((voice) => voice.setLoopPositionGlide(seconds));
    return this;
  }

  setGlideTime(seconds: number): this {
    this.#glideTime = seconds;
    return this;
  }

  /** Retune a playing voice instead of retriggering; `{ mode: 'off' }` restores normal triggering. */
  setLegato(settings: LegatoSettings): this {
    this.#voicePool.legato = { ...settings };
    return this;
  }

  setLoopEnabled(enabled: boolean): this {
    // if loop is locked (ON), turning it off is disabled but turning it on should work
    if (this.#loopLocked && !enabled) return this;

    this.#voicePool?.allVoices.forEach((v) => v.setLoopEnabled(enabled));
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
    this.#voicePool.applyToAllVoices((voice) => voice.setPlaybackDirection(direction));
    return this;
  }

  /**
   * Ping-pong loops turn around at both loop edges instead of jumping back, so
   * loop point order no longer matters. Without it, loop points set in reverse
   * order (start after end) make a backward loop: the voice plays through the
   * loop once, then cycles it backward. A short pitched loop played ping-pong
   * sounds an octave lower, since one cycle covers the loop twice.
   */
  setLoopPingPong(enabled: boolean): this {
    this.#voicePool.applyToAllVoices((voice) => voice.setLoopPingPong(enabled));
    return this;
  }

  setLoopDurationDriftAmount(amount: number): this {
    this.#voicePool.applyToAllVoices((voice) => voice.setLoopDurationDriftAmount(amount));
    return this;
  }

  setPanDriftEnabled = (enabled: boolean) => {
    this.#voicePool.applyToAllVoices((voice) => voice.setPanDriftEnabled(enabled));
    return this;
  };

  setTimestretchMode = (mode: TimestretchMode) => {
    this.#timestretchMode = mode;
    this.#sendPitchPeriods();
    this.#voicePool.applyToAllVoices((voice) => voice.setTimestretchMode(mode));
    return this;
  };

  /** Experimental: for comparing source interpolation by ear, may be removed. */
  setInterpolation = (mode: InterpolationMode) => {
    if (mode !== 'linear' && mode !== 'hermite' && mode !== 'sinc') {
      throw new RangeError('Interpolation mode must be linear, hermite or sinc');
    }
    this.#interpolationMode = mode;
    this.#voicePool?.applyToAllVoices((voice) => voice.setInterpolation(mode));
    return this;
  };

  // Only 'period' needs them, and detection blocks, so nothing pays for it until then.
  #sendPitchPeriods() {
    const buffer = this.#buffer;
    if (this.#timestretchMode !== 'period' || !buffer || this.#pitchPeriodsSent) return;
    const pitchPeriods = detectPitchPeriods(buffer.getChannelData(0), buffer.sampleRate);
    this.#voicePool.applyToAllVoices((voice) => voice.setPitchPeriods(pitchPeriods));
    this.#pitchPeriodsSent = true;
  }

  setLoopStart = (seconds: number) => {
    return this.#setLoopPoint('start', seconds, this.loopEnd);
  };

  setLoopEnd = (seconds: number) => {
    return this.#setLoopPoint('end', this.loopStart, seconds);
  };

  setLoopDuration = (seconds: number) =>
    this.#setLoopPoint('end', this.loopStart, this.loopStart + seconds);

  // Keytrack loop length to the played note (0 = fixed samples, 1 = constant loop time)
  setKeytrackLoopAmount(amount: number) {
    const clamped = Math.max(0, Math.min(1, amount));
    this.#keytrackLoopAmount = clamped;
    this.#voicePool.applyToAllVoices((voice) => voice.setKeytrackLoopAmount(clamped));
    return this;
  }

  getKeytrackLoopAmount = () => this.#keytrackLoopAmount;

  #setLoopPoint(loopPoint: 'start' | 'end', loopStartSeconds: number, loopEndSeconds: number) {
    // Each point is stored as given so the result doesn't depend on set order.
    // The processor resolves ordering, pitch quantization, zero-crossing snapping
    // and trim containment.
    const seconds = clamp(
      loopPoint === 'start' ? loopStartSeconds : loopEndSeconds,
      0,
      this.#bufferDuration,
    );
    const timestamp = this.context.currentTime;

    if (loopPoint === 'start') {
      if (seconds === this.loopStart) return this;
      this.#loopStart = seconds;
      this.#voicePool.applyToAllVoices((voice) => voice.setParam('loopStart', seconds, timestamp));
    } else {
      if (seconds === this.loopEnd) return this;
      this.#loopEnd = seconds;
      this.#voicePool.applyToAllVoices((voice) => voice.setParam('loopEnd', seconds, timestamp));
    }

    this.#sendUpstreamMessage('loop-points:updated', {
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });

    return this;
  }

  /** Set both loop points at once: one voice update, one loop-points:updated. */
  setLoopPoints(loopStartSeconds: number, loopEndSeconds: number) {
    const loopStart = clamp(loopStartSeconds, 0, this.#bufferDuration);
    const loopEnd = clamp(loopEndSeconds, 0, this.#bufferDuration);
    if (loopStart === this.loopStart && loopEnd === this.loopEnd) return this;

    const timestamp = this.context.currentTime;
    this.#loopStart = loopStart;
    this.#loopEnd = loopEnd;
    this.#voicePool.applyToAllVoices((voice) => voice.setLoopPoints(loopStart, loopEnd, timestamp));

    this.#sendUpstreamMessage('loop-points:updated', {
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });

    return this;
  }

  scrollLoopPoints(loopStart: number) {
    const loopDuration = this.loopEnd - this.loopStart;
    loopStart = clamp(
      loopStart,
      Math.max(0, -loopDuration),
      this.#bufferDuration - Math.max(0, loopDuration),
    );
    return this.setLoopPoints(loopStart, loopStart + loopDuration);
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

  // TODO: Consider moving source of truth from SampleVoice to SamplePlayer, or convert to MacroParams, symmetrical with the loop start/end points
  getStartPoint(): number {
    return this.#voicePool?.allVoices[0]?.startPoint ?? 0;
  }

  getEndPoint(): number {
    return this.#voicePool?.allVoices[0]?.endPoint ?? this.sampleDuration;
  }

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

    this.#voicePool.applyToAllVoices((voice) => voice.setEnvelopeConfig(id, next));

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

  /** Envelope ids on the current voices; empty until the pool is initialized. */
  get envelopeIds(): SampleEnvelopeId[] {
    return this.#voicePool?.allVoices[0]?.envelopeIds ?? [];
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
    return {
      ...(includeVoices ? this.#voicePool.getGainStages() : {}),
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
      this.#voicePool.applyToAllVoices((v) => {
        v.setLpfCutoff(hz);
      });
    }
    if (preOrPostFx === 'post' || preOrPostFx === 'all') {
      this.#outBus.setLpfCutoff(hz);
    }
  };

  setHpfCutoff = (hz: number, preOrPostFx: 'pre' | 'post' = 'post') => {
    this.#hpfCutoff = hz;
    if (preOrPostFx === 'pre') {
      this.#voicePool.applyToAllVoices((v) => {
        v.setHpfCutoff(hz);
      });
    } else if (preOrPostFx === 'post') {
      this.#outBus.setHpfCutoff(hz);
    }
  };

  setReverbAmount = (amount: number) => {
    this.#outBus.setReverbSize(amount);
  };

  setFeedbackDecay(value: number) {
    this.#outBus.setFeedbackDecay(value);
    this.#voicePool.applyToAllVoices((voice) => {
      voice.feedback?.setDecay(value);
    });
  }

  setFeedbackLowpassCutoff(freqHz: number) {
    this.#outBus.setFeedbackLowpassCutoff(freqHz);

    this.#voicePool.applyToAllVoices((voice) => {
      voice.feedback?.setLowpassCutoff(freqHz);
    });
  }

  // === FEEDBACK ===

  setFeedbackAmount = (amount: number) => {
    amount = clamp(amount, 0, 1);
    if (this.#feedbackMode === 'monophonic' || this.#feedbackMode === 'double-trouble') {
      this.#outBus.setFeedbackAmount(amount);
    }

    if (this.#feedbackMode === 'polyphonic' || this.#feedbackMode === 'double-trouble') {
      this.#voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(amount);
      });
    }
  };

  #feedbackMode: 'monophonic' | 'polyphonic' | 'double-trouble' = 'monophonic';

  setFeedbackMode(mode: 'monophonic' | 'polyphonic' | 'double-trouble') {
    this.#feedbackMode = mode;

    if (mode === 'monophonic') {
      let currAmount = this.#voicePool.allVoices[0].feedback?.currentAmount ?? 0;
      this.#voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(0);
      });
      this.#outBus.setFeedbackAmount(currAmount);
    } else if (mode === 'polyphonic') {
      const monoFx = this.#outBus.getFeedback();
      const currAmount = monoFx.currentAmount;

      this.#outBus.setFeedbackAmount(0);

      this.#voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(currAmount);
      });
    } else {
      console.info('Feedback mode set to double-trouble, radical!');
    }
  }

  setFeedbackPitchScale(value: number) {
    this.#outBus.setFeedbackPitchScale(value);

    this.#voicePool.applyToAllVoices((voice) => {
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

  //     this.#sendUpstreamMessage('midi:enabled', { channel });
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

  //   this.#sendUpstreamMessage('midi:disabled', { channel });

  //   return this;
  // }

  // switchMIDIChannel(channel: number | 'all') {
  //   this.#midiController?.switchInstrumentChannel(this, channel);
  // }

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
    this.#gainLFO?.setDepth(depth);
  }

  /** Set the pitch LFO rate in Hz. */
  setPitchLFOFrequency(hz: number): void {
    this.#pitchLFO?.setFrequency(hz);
  }

  /** Modulates voice detune; depth is in cents. */
  setPitchLFODepth(cents: number): void {
    this.#pitchLFO?.setDepth(cents);
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
    try {
      this.context.removeEventListener('statechange', this.#onContextStateChange);
      this.releaseAll();

      // Clear sustained notes
      this.#sustainedNotes.clear();

      if (this.#voicePool) {
        this.#voicePool.dispose();
        this.#voicePool = null as unknown as SampleVoicePool;
      }

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
