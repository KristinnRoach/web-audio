// SamplePlayer.ts - Refactored with Composition Pattern

import { Message, MessageHandler } from "@/events";
import { trimAudioBuffer, type FadeMs } from "@/utils/audiodata/process/trimBuffer";
import { clamp, ROOT_NOTES } from "@/utils";

import {
  preProcessAudioBuffer,
  PreProcessOptions,
  PreProcessResults,
} from "@/nodes/preprocessor/Preprocessor";

import { isValidAudioBuffer, isMidiValue } from "@/utils";

import { MacroParam, NormalizeOptions } from "@/nodes/params";
import { GainStages } from "@/nodes/LibNode";

import {
  isValidSamplerParamValue,
  samplerParams,
  type SamplerParams,
  type SamplerParamKey,
  type SamplerParamDescriptor,
} from "./sampler-params";

import { LFO } from "@/nodes/params/LFOs/LFO";
import { createInstrumentBus, type InstrumentBus } from "@/nodes/master/createInstrumentBus";
import { BusNodeName } from "@/nodes/master/InstrumentBus";
import { SampleVoicePool } from "./SampleVoicePool";
import {
  addPoint,
  deletePoint,
  setDuration,
  updatePoint,
  type Envelope,
  type EnvelopeSettings,
} from "@/nodes/params/envelopes";
import { ILibInstrumentNode } from "@/nodes/LibAudioNode";
import { registerNode, unregisterNode, NodeID } from "@/nodes/node-store";
import { createMessageBus, MessageBus } from "@/events";
import { CustomLibWaveform, WaveformOptions } from "@/utils/audiodata/generate/generateWaveform";
import { createSampleVoicePool } from "./createSampleVoicePool";
import { getAudioContext } from "@/context";
import type { SampleVoiceChainNode } from "./SampleVoice";
import { ENVELOPE_TARGETS, type EnvelopeId } from "../../params/envelopes/envelope-targets";

function cloneEnvelopeSettings(settings: EnvelopeSettings): EnvelopeSettings {
  return {
    ...settings,
    envelope: {
      ...settings.envelope,
      points: settings.envelope.points.map((point) => ({ ...point })),
    },
  };
}

const ENVELOPE_IDS = Object.keys(ENVELOPE_TARGETS) as EnvelopeId[];

function validateEnvelopeSettings(settings: EnvelopeSettings): void {
  const { envelope } = settings;
  const points = envelope?.points;
  const validMarker = (index: number | undefined) =>
    index === undefined || (Number.isInteger(index) && index >= 0 && index < points.length);

  if (
    typeof settings?.enabled !== "boolean" ||
    !Number.isFinite(settings?.timeScale) ||
    settings.timeScale <= 0 ||
    !Array.isArray(points) ||
    points.length < 2 ||
    (envelope.loop !== undefined && typeof envelope.loop !== "boolean") ||
    points.some(
      (point, index) =>
        !Number.isFinite(point.time) ||
        !Number.isFinite(point.value) ||
        (point.curve !== undefined &&
          point.curve !== "step" &&
          point.curve !== "linear" &&
          point.curve !== "exponential") ||
        (index > 0 && point.time < points[index - 1].time),
    ) ||
    !validMarker(envelope.sustain) ||
    !validMarker(envelope.release)
  ) {
    throw new TypeError("Invalid envelope settings");
  }
}

/**
 * Filter envelope depth, normalized against the filter's usable range.
 *
 * 0.13 is roughly the 3 kHz this was fixed at before, at a 48 kHz sample rate.
 */
const DEFAULT_FILTER_ENV_AMOUNT = 0.13;

export type SamplePlayerOptions = {
  context?: AudioContext;
  polyphony?: number;
  audioBuffer?: AudioBuffer;
  voiceSignalChain?: readonly SampleVoiceChainNode[];
};

export class SamplePlayer implements ILibInstrumentNode {
  public readonly nodeId: NodeID;
  readonly nodeType = "sample-player" as const;
  readonly context: AudioContext;
  #messages: MessageBus<Message>;

  #initialized = false;
  #initPromise: Promise<void> | null = null;
  #isLoaded = false;
  private readonly envelopeSettings = new Map<EnvelopeId, EnvelopeSettings>();
  private readonly playbackRateSyncedEnvelopes = new Set<EnvelopeId>();
  #polyphony: number;
  #voiceSignalChain?: readonly SampleVoiceChainNode[];
  #initialAudioBuffer: AudioBuffer | null = null;

  #connections = new Set<NodeID>();
  #incoming = new Set<NodeID>();

  #audiobuffer: AudioBuffer | null = null;
  #layers: AudioBuffer[] = [];
  static readonly MAX_LAYERS = 4;
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
  #filterEnvAmount: number = DEFAULT_FILTER_ENV_AMOUNT;
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

  constructor(options: SamplePlayerOptions = {}) {
    this.nodeId = registerNode("sample-player", this);
    this.context = options.context ?? getAudioContext();

    // Synchronus setup
    this.#messages = createMessageBus<Message>(this.nodeId);

    this.#masterOut = new GainNode(this.context, { gain: 0.5 });

    // Seconds; the real loop range is set from the buffer duration in
    // #resetMacros once a sample is loaded.
    this.#macroLoopStart = new MacroParam(this.context, 0);
    this.#macroLoopEnd = new MacroParam(this.context, 0);

    // Store configuration for async init
    this.#polyphony = options.polyphony ?? 16;
    this.#voiceSignalChain = options.voiceSignalChain ? [...options.voiceSignalChain] : undefined;
    this.#initialAudioBuffer = options.audioBuffer ?? null;
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
          this.#voiceSignalChain,
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

        const errorMessage = error instanceof Error ? error.message : String(error);
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
    const target = "input" in destination && destination.input ? destination.input : destination;

    this.#masterOut.connect(target as AudioNode);

    // Track the connection by NodeID if possible
    if ("nodeId" in destination) {
      this.#connections.add(destination.nodeId);
      (destination as any).addIncoming?.(this.nodeId);
    }
  }

  public disconnect(destination?: ILibInstrumentNode | AudioNode): void {
    if (destination) {
      const target = "input" in destination ? destination.input : destination;
      this.#masterOut.disconnect(target as AudioNode);
      if ("nodeId" in destination) {
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
    this.voicePool.onMessage("sample:loaded", () => {
      this.#isLoaded = true;

      // Rescale every shape to the new buffer and push it down. Voices come up on
      // their own defaults, so this is also what first puts them on the owned state -
      // without it the player and its voices would hold different shapes.
      ENVELOPE_IDS.forEach((id) => {
        const settings = this.getEnvelopeSettings(id);
        this.applyEnvelopeSettings(id, {
          ...settings,
          envelope: setDuration(settings.envelope, this.#bufferDuration),
        });
      });
    });

    this.voicePool.onMessage("voice-pool:initialized", () => {
      // Fresh voices start on defaults, so hand them the owned state before they play.
      ENVELOPE_IDS.forEach((id) =>
        this.#applyEnvelopeSettingsToVoices(id, this.getEnvelopeSettings(id)),
      );
      this.playbackRateSyncedEnvelopes.forEach((id) =>
        this.voicePool.applyToAllVoices((voice) => voice.setEnvelopePlaybackRateSync(id, true)),
      );
      this.sendUpstreamMessage("sample-player:initialized", {});
    });

    // Forward voice pool messages upstream
    this.#messages.forwardFrom(this.voicePool, [
      "voice-pool:initialized",
      "voice:started",
      "voice:stopped",
      "voice:releasing",
      "sample:loaded",

      "amp-env:created",
      "amp-env:trigger",
      "amp-env:trigger:loop",
      "amp-env:release",

      "pitch-env:created",
      "pitch-env:trigger",
      "pitch-env:trigger:loop",
      "pitch-env:release",

      "filter-env:created",
      "filter-env:trigger",
      "filter-env:trigger:loop",
      "filter-env:release",
    ]);
    return this;
  }

  /* === MACROS === */

  getMacrosAudioParam(paramName: "loopStart" | "loopEnd") {
    switch (paramName) {
      case "loopStart":
        return this.#macroLoopStart.audioParam;
      case "loopEnd":
        return this.#macroLoopEnd.audioParam;
      default:
        throw new Error("Unknown macro parameter");
    }
  }

  getMacro(paramName: "loopStart" | "loopEnd") {
    switch (paramName) {
      case "loopStart":
        return this.#macroLoopStart;
      case "loopEnd":
        return this.#macroLoopEnd;
      default:
        throw new Error("Unknown macro parameter");
    }
  }

  #connectVoicesToMacros(): this {
    const voices = this.voicePool.allVoices;

    voices.forEach((voice) => {
      const loopStartParam = voice.getParam("loopStart");
      const loopEndParam = voice.getParam("loopEnd");

      if (loopStartParam) {
        this.#macroLoopStart.addTarget(loopStartParam, "loopStart");
      } else {
        console.error("loopStart param is null!");
      }

      if (loopEndParam) {
        this.#macroLoopEnd.addTarget(loopEndParam, "loopEnd");
      } else {
        console.error("loopEnd param is null!");
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

  setModulationAmount = (modType: "AM" | "FM", amount: number) =>
    this.voicePool.applyToAllVoices((v) => v.setModulationAmount(modType, amount));

  setAMModOctaveOffset = (offset: number) =>
    this.voicePool.applyToAllVoices((v) => v.setAMModOctaveOffset(offset));

  setModulationWaveform(
    modType: "AM" | "FM" = "AM",
    waveform: CustomLibWaveform | OscillatorType | PeriodicWave = "triangle",
    customWaveOptions: WaveformOptions = {},
  ) {
    this.voicePool.applyToAllVoices((v) =>
      v.setModulationWaveform(modType, waveform, customWaveOptions),
    );
  }

  syncLFOsToNoteFreq(lfoId: "gain-lfo" | "pitch-lfo", enabled: boolean) {
    if (lfoId === "gain-lfo") {
      if (enabled === true) {
        this.#gainLFO?.storeCurrentValues();
      } else {
        const storedVals = this.#gainLFO?.getStoredValues();
        if (storedVals) this.#gainLFO?.setFrequency(storedVals.rate);
      }

      this.#syncGainLFOToMidiNote = enabled;
    }
    if (lfoId === "pitch-lfo") {
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
    this.#gainLFO = new LFO(this.context);
    this.#gainLFO.setWaveform("sine");

    this.#pitchLFO = new LFO(this.context);
    const wobbleWave = this.#pitchLFO.getPitchWobbleWaveform();
    this.#pitchLFO.setWaveform(wobbleWave);

    // Connections
    this.#connectLFOToAllVoices(this.#pitchLFO, "playbackRate");
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

  /**
   * Load a single sample. Equivalent to `loadLayers([buffer])`: any previously
   * loaded extra layers are cleared.
   */
  async loadSample(
    buffer: AudioBuffer | ArrayBuffer,
    modSampleRate?: number,
    preprocessOptions?: Partial<PreProcessOptions>,
  ): Promise<AudioBuffer | null> {
    const loaded = await this.loadLayers([buffer], modSampleRate, preprocessOptions);
    return loaded?.[0] ?? null;
  }

  /**
   * Replace the whole layer set. Layers are summed inside the voice worklet at
   * one shared playhead, so they play in unison and layer 0 is the authority
   * for duration, loop points, start/end and zero crossings. Layers shorter
   * than layer 0 fall silent at their own end; longer ones are truncated.
   */
  async loadLayers(
    buffers: (AudioBuffer | ArrayBuffer)[],
    modSampleRate?: number,
    preprocessOptions?: Partial<PreProcessOptions>,
  ): Promise<AudioBuffer[] | null> {
    if (this.#isLoading) {
      throw new Error("A sample load is already in progress");
    }
    this.#isLoading = true;
    let unsubscribe: (() => void) | undefined;

    try {
      if (buffers.length > SamplePlayer.MAX_LAYERS) {
        console.warn(`Ignoring layers past ${SamplePlayer.MAX_LAYERS}; got ${buffers.length}`);
        buffers = buffers.slice(0, SamplePlayer.MAX_LAYERS);
      }

      const decoded: AudioBuffer[] = [];
      for (const [index, input] of buffers.entries()) {
        let buffer = input;

        if (buffer instanceof ArrayBuffer) {
          // decodeAudioData detaches its input; copy so callers can safely
          // reuse/re-pass the same ArrayBuffer (e.g. re-selecting a cached sample).
          try {
            buffer = await this.context.decodeAudioData(buffer.slice(0));
          } catch (error) {
            if (index === 0) throw error;
            console.warn(`Failed to decode layer ${index}; skipping`, error);
            continue;
          }
        }

        if (!isValidAudioBuffer(buffer)) {
          console.error(`Invalid AudioBuffer provided for layer ${index}`);
          if (index === 0) return null;
          continue;
        }

        if (buffer.sampleRate !== this.context.sampleRate) {
          // Layer 0 is the authority, so a mismatch there is fatal as before.
          // Extra layers are dropped individually and the rest still play.
          const message = `Sample rate mismatch: layer ${index} rate ${buffer.sampleRate}, context rate ${this.context.sampleRate}`;
          if (index === 0) throw new RangeError(message);
          console.warn(message);
          continue;
        }

        decoded.push(buffer);
      }

      if (!decoded.length) return null;

      if (modSampleRate && this.context.sampleRate !== modSampleRate) {
        console.warn(
          `Sample rate mismatch: context rate ${this.context.sampleRate}, requested rate ${modSampleRate}`,
        );
      }

      const layers: AudioBuffer[] = [];
      let newZeroCrossings: number[] = [];

      for (const [index, buffer] of decoded.entries()) {
        if (!this.#preprocessAudio) {
          layers.push(buffer);
          continue;
        }

        // Preprocess each layer (re-pitch, trim, normalize, etc.).
        // Zero crossings are only used for the authority layer.
        const processed: PreProcessResults = await preProcessAudioBuffer(
          this.context,
          buffer,
          preprocessOptions,
        );
        layers.push(processed.audiobuffer);

        if (index === 0 && this.#useZeroCrossings && processed.zeroCrossings) {
          newZeroCrossings = processed.zeroCrossings;
        }
      }

      // Clear and release only if all preprocessing succeeds.
      this.releaseAll(0);
      this.transposeSemitones = 0;
      this.#isLoaded = false;
      this.#layers = layers;
      this.#audiobuffer = layers[0];
      this.#bufferDuration = layers[0].duration;
      this.#zeroCrossings = newZeroCrossings;

      const loadedPromise = new Promise<void>((resolve) => {
        unsubscribe = this.voicePool.onMessage("sample:loaded", () => {
          resolve();
        });
      });

      this.voicePool.setLayers(layers, newZeroCrossings);
      this.#resetMacros();

      const defaultScaleOptions = {
        rootNote: "C" as keyof typeof ROOT_NOTES,
        scale: [0],
        lowestOctave: 0,
        highestOctave: 5,
        tuningOffset: 0,
        normalize: false as NormalizeOptions | false,
      };

      this.setScale(defaultScaleOptions);

      await loadedPromise;
      return [...layers];
    } finally {
      unsubscribe?.();
      this.#isLoading = false;
    }
  }

  /**
   * Replace the loaded sample with the region between its start and end points,
   * reloading it without re-running preprocessing.
   *
   * Seconds are clamped to the buffer. Returns null if there is no sample
   * loaded, the bounds aren't finite, or the region is empty.
   */
  async cropSample(
    startSeconds = this.getStartPoint(),
    endSeconds = this.getEndPoint(),
    fadeMs: FadeMs = { in: "default", out: "default" },
  ): Promise<AudioBuffer | null> {
    const buffer = this.#audiobuffer;
    if (!buffer) return null;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      return null;
    }

    const startSample = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
    const endSample = Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate));

    if (endSample <= startSample) return null;

    const croppedBuffer = trimAudioBuffer(this.context, buffer, startSample, endSample, fadeMs);

    return this.loadSample(croppedBuffer, undefined, {
      skipPreProcessing: true,
    });
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

    if (this.#syncGainLFOToMidiNote) this.#gainLFO?.setMusicalNote(transposedMidiNote);
    if (this.#syncPitchLFOToMidiNote) {
      this.#pitchLFO?.setMusicalNote(transposedMidiNote, { divisor: 4 });
    }

    this.outBus.noteOn(transposedMidiNote, safeVelocity, 0, glideTime);

    return this.voicePool.noteOn(transposedMidiNote, safeVelocity, 0, glideTime);
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
    this.outBus.noteOff(transposedMidiNote);
    this.sendUpstreamMessage("note:off", { transposedMidiNote });
    return this;
  }

  releaseAll(releaseTime?: number): this {
    this.#sustainedNotes.clear();
    this.voicePool?.allNotesOff(releaseTime);
    this.outBus?.releaseAll();
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

  /**
   * Sets the periods both loop macros snap to, using the loaded sample's zero
   * crossings. Called on every sample load, so it must run after the buffer.
   */
  setScale(options: {
    rootNote: keyof typeof ROOT_NOTES;
    /** Custom pattern as semitone offsets from the root. */
    scale: number[];
    /** Shifts every allowed period by this many semitones. Positive is up. */
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

  /** Transposes playback to the new root and rebuilds both loop macros' periods. */
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

    this.sendUpstreamMessage("start-point:updated", {
      startPoint: seconds,
    });
    return this;
  }

  setSampleEndPoint(seconds: number): this {
    this.voicePool.applyToAllVoices((voice) => voice.setEndPoint(seconds));

    this.sendUpstreamMessage("end-point:updated", {
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

    this.sendUpstreamMessage("loop:enabled", { enabled });
    return this;
  }

  setLoopLocked(locked: boolean): this {
    if (this.#loopLocked === locked) return this;

    this.#loopLocked = locked;
    this.setLoopEnabled(locked);

    this.sendUpstreamMessage("loop:locked", { locked });
    return this;
  }

  setHoldEnabled(enabled: boolean) {
    if (this.#holdEnabled === enabled) return this;
    if (this.#holdLocked && !enabled) return this;

    this.#holdEnabled = enabled;
    if (!enabled) this.releaseAll(0.1);
    this.sendUpstreamMessage("hold:enabled", { enabled });
    return this;
  }

  setHoldLocked(locked: boolean): this {
    if (this.#holdLocked === locked) return this;

    this.#holdLocked = locked;
    if (locked === false) this.releaseAll();

    this.sendUpstreamMessage("hold:locked", { locked });
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
        this.outBus.noteOff(note);
        this.sendUpstreamMessage("note:off", { transposedMidiNote: note });
      }
      this.#sustainedNotes.clear();
    }

    return this;
  }

  sustainPedalOn = (): this => this.setSustainPedal(true);
  sustainPedalOff = (): this => this.setSustainPedal(false);

  setPlaybackDirection(direction: "forward" | "reverse"): this {
    this.voicePool.applyToAllVoices((voice) => voice.setPlaybackDirection(direction));
    return this;
  }

  setLoopDurationDriftAmount(amount: number): this {
    this.voicePool.applyToAllVoices((voice) => voice.setLoopDurationDriftAmount(amount));
    return this;
  }

  setPanDriftEnabled = (enabled: boolean) => {
    this.voicePool.applyToAllVoices((voice) => voice.setPanDriftEnabled(enabled));
    return this;
  };

  setTimestretchEnabled = (enabled: boolean) => {
    this.voicePool.applyToAllVoices((voice) => voice.setTimestretchEnabled(enabled));
    return this;
  };

  isNormalized = (value: number, range = [0, 1]) => value >= range[0] && value <= range[1];

  readonly MIN_LOOP_DURATION_SECONDS = 1 / 523.25; // C5 = 523.25 Hz, C6 = 1046.502

  setLoopStart = (seconds: number, rampTime: number = this.getLoopRampDuration()) => {
    return this.setLoopPoint("start", seconds, this.loopEnd, rampTime);
  };

  setLoopEnd = (seconds: number, rampTime: number = this.getLoopRampDuration()) => {
    return this.setLoopPoint("end", this.loopStart, seconds, rampTime);
  };

  setLoopDuration = (seconds: number, rampTime: number = this.getLoopRampDuration()) =>
    this.setLoopPoint("end", this.loopStart, this.loopStart + seconds, rampTime);

  debugcounter = 0;

  setTempo(bpm: number) {
    if (bpm < this.#MIN_TEMPO || bpm > this.#MAX_TEMPO) return;
    this.#tempo = bpm;

    this.voicePool.applyToAllVoices((voice) => voice.setTempo(bpm));

    this.sendUpstreamMessage("tempo:updated", { bpm });
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
    this.voicePool.applyToAllVoices((voice) => voice.setKeytrackLoopAmount(clamped));
    return this;
  }

  getKeytrackLoopAmount = () => this.#keytrackLoopAmount;

  get tempo() {
    return this.#tempo;
  }

  setLoopPoint(
    loopPoint: "start" | "end",
    loopStartSeconds: number,
    loopEndSeconds: number,
    rampDuration: number = this.getLoopRampDuration(),
  ) {
    let loopStart =
      loopPoint === "start"
        ? clamp(loopStartSeconds, this.MIN_LOOP_DURATION_SECONDS / 2, loopEndSeconds)
        : loopStartSeconds;

    if (loopPoint === "start" && loopStart === this.loopStart) return this;

    let loopEnd = clamp(
      loopEndSeconds,
      loopStart,
      this.#bufferDuration - this.MIN_LOOP_DURATION_SECONDS / 2,
    );

    if (loopPoint === "end" && loopEnd === this.loopEnd) return this;

    const targetLoopDuration = loopEnd - loopStart;

    if (loopPoint === "start" && loopStart !== this.loopStart) {
      // handle tempo loop sync for loop start
      if (this.#loopTempoSync) {
        const beatDuration = 60 / this.#tempo;
        const numBeats = Math.round(targetLoopDuration / beatDuration);
        loopStart = loopEnd - numBeats * beatDuration;
      }

      if (targetLoopDuration < this.MIN_LOOP_DURATION_SECONDS) {
        loopStart = loopEnd - this.MIN_LOOP_DURATION_SECONDS;
      }

      this.#macroLoopStart.ramp(loopStart, rampDuration, loopEnd);
    } else if (loopPoint === "end" && loopEnd !== this.loopEnd) {
      // handle tempo loop sync for loop end
      if (this.#loopTempoSync) {
        const beatDuration = 60 / this.#tempo;
        const numBeats = Math.round(targetLoopDuration / beatDuration);
        loopEnd = loopStart + numBeats * beatDuration;
      }

      if (targetLoopDuration < this.MIN_LOOP_DURATION_SECONDS) {
        loopEnd = loopStart + this.MIN_LOOP_DURATION_SECONDS;
      }

      this.#macroLoopEnd.ramp(loopEnd, rampDuration, loopStart);
    }

    this.sendUpstreamMessage("loop-points:updated", {
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });

    return this;
  }

  scrollLoopPoints(loopStart: number, loopEnd: number) {
    const timestamp = this.context.currentTime;
    this.#macroLoopStart.setValue(loopStart, timestamp);
    this.#macroLoopEnd.setValue(loopEnd, timestamp);

    this.sendUpstreamMessage("loop-points:updated", {
      loopStart: this.loopStart,
      loopEnd: this.loopEnd,
    });

    return this;
  }

  setParam(name: string, value: number): this {
    switch (name) {
      case "startPoint":
        this.setSampleStartPoint(value);
        break;
      case "endPoint":
        this.setSampleEndPoint(value);
        break;
      case "glideTime":
        this.setGlideTime(value);
        break;
      case "loopStart":
        this.setLoopStart(value);
        break;
      case "loopEnd":
        this.setLoopEnd(value);
        break;
      case "loopRampDuration":
        this.setLoopRampDuration(value);
        break;
      default:
        console.warn(`Unknown parameter: ${name}`);
    }
    return this;
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

  getAudioParam(name: string): AudioParam | null {
    switch (name) {
      case "loopStart":
        return this.#macroLoopStart.audioParam;
      case "loopEnd":
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
      case "loopStart":
        return this.loopStart;
      case "loopEnd":
        return this.loopEnd;
      case "loopRampDuration":
        return this.getLoopRampDuration();
      case "startPoint":
        return this.getStartPoint();
      case "endPoint":
        return this.getEndPoint();
      case "glideTime":
        return this.getGlideTime();
      case "hpfCutoff":
        return this.getHpfCutoff();
      case "lpfCutoff":
        return this.getLpfCutoff();
      default:
        console.warn(`Unknown parameter: ${name}`);
        return undefined;
    }
  }

  /* === PITCH === */

  setPitchEnabled(enabled: boolean): this {
    this.voicePool.allVoices.forEach((v) => (enabled ? v.enablePitch() : v.disablePitch()));
    return this;
  }

  /* === ENVELOPES === */

  /**
   * Returns detached, serializable envelope settings.
   *
   * This map is the only copy of envelope settings in the instrument. Voices hold a
   * pushed-down duplicate they can schedule from but never write to, so there is no
   * second authority to read back from and nothing to invalidate.
   */
  getEnvelopeSettings(id: EnvelopeId): EnvelopeSettings {
    const stored = this.envelopeSettings.get(id);
    if (stored) return cloneEnvelopeSettings(stored);

    const settings = ENVELOPE_TARGETS[id].defaults(this.sampleDuration || 1);
    this.envelopeSettings.set(id, settings);
    return cloneEnvelopeSettings(settings);
  }

  /** Applies a complete snapshot and emits one `envelope:changed` message. */
  applyEnvelopeSettings(id: EnvelopeId, settings: EnvelopeSettings): void {
    validateEnvelopeSettings(settings);

    const next = cloneEnvelopeSettings(settings);
    this.envelopeSettings.set(id, next);

    this.#applyEnvelopeSettingsToVoices(id, next);

    if (id === "filter-env") {
      this.applyPostFilterEnvelope(next);
    }

    this.sendUpstreamMessage("envelope:changed", {
      envelopeId: id,
      settings: cloneEnvelopeSettings(next),
    });
  }

  /**
   * The post-FX cutoff follows the same envelope definition. It has no per-note
   * playback rate, so only the envelope's own time scale applies.
   */
  private applyPostFilterEnvelope(settings: EnvelopeSettings): void {
    this.setLpfEnvelope(settings.envelope, {
      amount: settings.enabled ? this.#filterEnvAmount : 0,
      timeScale: settings.timeScale,
    });
  }

  /** Restores one envelope to defaults sized to the current authority sample. */
  resetEnvelope(id: EnvelopeId): void {
    this.applyEnvelopeSettings(id, ENVELOPE_TARGETS[id].defaults(this.sampleDuration || 1));
  }

  /** Restores all envelopes to defaults sized to the current sample. */
  resetEnvelopes(): void {
    ENVELOPE_IDS.forEach((id) => this.resetEnvelope(id));
  }

  #applyEnvelopeSettingsToVoices(id: EnvelopeId, settings: EnvelopeSettings): void {
    this.voicePool.applyToAllVoices((voice) => voice.applyEnvelopeSettings(id, settings));
  }

  /** Envelope types on the current voices; empty until the pool is initialized. */
  get availableEnvelopeIds(): EnvelopeId[] {
    return [...(this.voicePool?.allVoices[0]?.envelopes.keys() ?? [])];
  }

  setEnvelopeSync = (id: EnvelopeId, sync: boolean) => {
    if (sync) this.playbackRateSyncedEnvelopes.add(id);
    else this.playbackRateSyncedEnvelopes.delete(id);
    this.voicePool.applyToAllVoices((voice) => voice.setEnvelopePlaybackRateSync(id, sync));
  };

  // setEnvelopeTimeScale = (id: EnvelopeId, timeScale: number) => {
  //   this.applyEnvelopeSettings(id, { ...this.getEnvelopeSettings(id), timeScale });
  // };

  // setEnvelopeSustainPoint(id: EnvelopeId, index?: number) {
  //   const settings = this.getEnvelopeSettings(id);
  //   this.applyEnvelopeSettings(id, {
  //     ...settings,
  //     envelope: { ...settings.envelope, sustain: index },
  //   });
  // }

  // setEnvelopeReleasePoint(id: EnvelopeId, index?: number) {
  //   const settings = this.getEnvelopeSettings(id);
  //   this.applyEnvelopeSettings(id, {
  //     ...settings,
  //     envelope: { ...settings.envelope, release: index },
  //   });
  // }

  // updateEnvelopePoint(id: EnvelopeId, index: number, time: number, value: number): void {
  //   this.#editEnvelope(id, (envelope) => updatePoint(envelope, index, time, value));
  // }

  // addEnvelopePoint(id: EnvelopeId, time: number, value: number): void {
  //   this.#editEnvelope(id, (envelope) => addPoint(envelope, time, value));
  // }

  // deleteEnvelopePoint(id: EnvelopeId, index: number): void {
  //   this.#editEnvelope(id, (envelope) => deletePoint(envelope, index));
  // }

  // #editEnvelope(id: EnvelopeId, edit: (envelope: Envelope) => Envelope): void {
  //   const settings = this.getEnvelopeSettings(id);
  //   this.applyEnvelopeSettings(id, { ...settings, envelope: edit(settings.envelope) });
  // }

  /**
   * Named tap points covering the whole instrument, from inside the voices
   * through the bus to master out.
   * Pass to `monitorLevels` from `@kidlib/web-audio/debug`.
   */
  getGainStages({ includeVoices = true } = {}): GainStages {
    const busStages = Object.entries(this.outBus.getGainStages()).map(([name, node]) => [
      `bus.${name}`,
      node,
    ]);
    return {
      ...(includeVoices ? this.voicePool.getGainStages() : {}),
      ...Object.fromEntries(busStages),
      masterOut: this.#masterOut,
    };
  }

  /* === FX === */

  setDryWetMix = (mix: { dry: number; wet: number }) => {
    this.outBus.setDryWetMix(mix);
  };

  sendToFx = (effect: BusNodeName, amount: number) => {
    this.outBus.setSendAmount(effect, amount);
  };

  setLpfCutoff = (hz: number, preOrPostFx: "pre" | "post" | "all" = "all") => {
    this.#lpfCutoff = hz;
    if (preOrPostFx === "pre" || preOrPostFx === "all") {
      this.voicePool.applyToAllVoices((v) => {
        v.setLpfCutoff(hz);
      });
    }
    if (preOrPostFx === "post" || preOrPostFx === "all") {
      this.outBus.setLpfCutoff(hz);
    }
  };

  /**
   * Envelope for the post-FX lowpass cutoff. See `InstrumentBus.setLpfEnvelope`.
   * Set `setLpfCutoff` low first - it is the base the sweep starts from, and it
   * defaults to wide open, where a sweep upwards is inaudible.
   */
  setLpfEnvelope = (
    envelope: Envelope | null,
    options: { amount?: number; timeScale?: number } = {},
  ) => {
    this.outBus.setLpfEnvelope(envelope, options);
  };

  setHpfCutoff = (hz: number, preOrPostFx: "pre" | "post" = "post") => {
    this.#hpfCutoff = hz;
    if (preOrPostFx === "pre") {
      this.voicePool.applyToAllVoices((v) => {
        v.setHpfCutoff(hz);
      });
    } else if (preOrPostFx === "post") {
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
    if (this.#feedbackMode === "monophonic" || this.#feedbackMode === "double-trouble") {
      this.outBus.setFeedbackAmount(amount);
    }

    if (this.#feedbackMode === "polyphonic" || this.#feedbackMode === "double-trouble") {
      this.voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(amount);
      });
    }
  };

  #feedbackMode: "monophonic" | "polyphonic" | "double-trouble" = "monophonic";

  setFeedbackMode(mode: "monophonic" | "polyphonic" | "double-trouble") {
    this.#feedbackMode = mode;

    if (mode === "monophonic") {
      let currAmount = this.voicePool.allVoices[0].feedback?.currentAmount ?? 0;
      this.voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(0);
      });
      this.outBus.setFeedbackAmount(currAmount);
    } else if (mode === "polyphonic") {
      const monoFx = this.outBus.getFeedback();
      const currAmount = monoFx.currentAmount;

      this.outBus.setFeedbackAmount(0);

      this.voicePool.applyToAllVoices((voice) => {
        voice.feedback?.setAmountMacro(currAmount);
      });
    } else {
      console.info("Feedback mode set to double-trouble, radical!");
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

  /** All loaded layers. Index 0 is the authority layer (=== `audiobuffer`). */
  get layers(): readonly AudioBuffer[] {
    return [...this.#layers];
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
      this.#audiobuffer = null;
      this.#layers = [];
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
