import { SampleVoice, type SampleVoiceChainNode } from './SampleVoice';
import { registerNode, unregisterNode, NodeID } from '@/nodes/node-store';
import { VoiceState } from '../VoiceState';
import { Message, MessageHandler, MessageBus, createMessageBus } from '@/events';
import { GainStages, LibNode } from '@/nodes/LibNode';
import { createSampleVoices } from './createSampleVoice';
import { VoiceAllocator } from '@/worklets/processors/play/engine/voice-allocator.js';

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

export class SampleVoicePool implements LibNode {
  readonly nodeId: NodeID;
  readonly nodeType = 'pool';
  #messages: MessageBus<Message>;
  #context: BaseAudioContext;
  #initialized = false;
  #initPromise: Promise<void> | null = null;
  #polyphony: number;
  #voiceSignalChain?: readonly SampleVoiceChainNode[];

  #allVoices: SampleVoice[] = [];
  #loaded = new Set<NodeID>();
  // Decides; this class applies. Lives with the engine so it can move into the processor.
  #allocator = new VoiceAllocator();

  constructor(
    context: BaseAudioContext,
    polyphony: number,
    voiceSignalChain?: readonly SampleVoiceChainNode[],
  ) {
    this.nodeId = registerNode(this.nodeType, this);
    this.#messages = createMessageBus<Message>(this.nodeId);
    this.#context = context;
    this.#polyphony = polyphony;
    this.#voiceSignalChain = voiceSignalChain ? [...voiceSignalChain] : undefined;
  }

  async init() {
    if (this.#initialized) return;
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      try {
        this.#allVoices = await createSampleVoices(this.#polyphony, this.#context, {
          internalSignalChain: this.#voiceSignalChain,
        });

        this.#allocator.voices = this.#allVoices;
        this.#allVoices.forEach((voice) => {
          this.#setupMessageHandling(voice);
        });
        this.#initialized = true;
      } catch (error) {
        this.#allVoices.forEach((voice) => voice.dispose());
        this.#allVoices = [];
        this.#initPromise = null;

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to initialize SamplePlayer: ${errorMessage}`);
      }
    })();

    return this.#initPromise;
  }

  connect(destination: AudioNode) {
    this.#allVoices.forEach((voice) => {
      voice.connect(destination);
    });
  }

  disconnect() {
    this.#allVoices.forEach((voice) => {
      voice.disconnect();
    });
  }

  /**
   * Named tap points inside the voices, prefixed `voice.`, each one metered as
   * the sum of that stage across every voice. Reads whatever is playing without
   * depending on which voice the allocator picked; with a chord it shows the
   * summed level at that stage rather than any single voice.
   */
  getGainStages(): GainStages {
    const perVoice = this.#allVoices.map((voice) => voice.getGainStages());
    const stageNames = Object.keys(perVoice[0] ?? {});
    return Object.fromEntries(
      stageNames.map((name) => [`voice.${name}`, perVoice.map((stages) => stages[name])]),
    );
  }

  /* === MESSAGES === */

  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  #sendUpstreamMessage(type: string, data: any) {
    this.#messages.sendMessage(type, data);
    return this;
  }

  #initializedVoices = new Set<NodeID>();

  #setupMessageHandling(voice: SampleVoice) {
    voice.onMessage('voice:initialized', () => {
      this.#initializedVoices.add(voice.nodeId);

      if (this.#initializedVoices.size === this.#allVoices.length) {
        // All voices initialized message
        this.#sendUpstreamMessage('voice-pool:initialized', {
          voiceCount: this.#allVoices.length,
        });
      }
    });

    this.#messages.forwardFrom(
      voice,
      [
        'voice:started',
        'voice:stopped',
        'voice:releasing',
        'voice:loaded',
        'loop:range',
        'trim:range',
        'voice:position',
      ],
      (msg) => {
        if (msg.type === 'voice:loaded') {
          this.#loaded.add(msg.senderId);

          // Only send 'sample:loaded' when all voices are loaded
          if (this.#loaded.size === this.#allVoices.length) {
            return { ...msg, type: 'sample:loaded' };
          }
          return null;
        }
        return msg;
      },
    );
  }

  setBuffer(buffer: AudioBuffer, zeroCrossings?: number[]) {
    // Reset loaded voices tracking for new buffer
    this.#loaded.clear();
    this.#allVoices.forEach((voice) => voice.loadBuffer(buffer, zeroCrossings));
    return this;
  }

  allocate(): SampleVoice | undefined {
    const voice = this.#allocator.selectVoice(this.#allVoices) as SampleVoice | undefined;

    if (!voice) {
      console.warn('Could not allocate voice');
      return;
    }

    if (voice.state !== VoiceState.AVAILABLE) voice.stop();

    return voice;
  }

  prevMidiNote = 60;

  get legato(): LegatoSettings {
    return this.#allocator.legato;
  }

  set legato(settings: LegatoSettings) {
    this.#allocator.legato = settings;
  }

  noteOn(
    midiNote: MidiValue,
    velocity: MidiValue = 100,
    secondsFromNow = 0,
    glideTime = 0,
  ): { midiNote: MidiValue; glideTime: number; retuned: boolean } | null {
    const decision = this.#allocator.noteOn(midiNote, glideTime);
    if (!decision) {
      console.warn('Could not allocate voice');
      return null;
    }

    for (const action of decision.actions) {
      const voice = action.voice as SampleVoice;
      if (action.type === 'steal') voice.stop();
      else if (action.type === 'release') voice.release({ secondsFromNow });
      else {
        const success =
          action.type === 'retune'
            ? voice.retune(midiNote, secondsFromNow, decision.glideTime)
            : voice.trigger({
                midiNote,
                velocity,
                secondsFromNow,
                glide: { fromMidiNote: this.prevMidiNote, seconds: decision.glideTime },
              });
        if (success === null) return null;
        decision.commit();
      }
    }
    this.prevMidiNote = midiNote;
    return { midiNote, glideTime: decision.glideTime, retuned: decision.retuned };
  }

  /** Returns the earlier held note a legato voice fell back to, if any. */
  noteOff(
    midiNote: MidiValue,
    secondsFromNow: number = 0,
  ): { midiNote: MidiValue; glideTime: number } | null {
    let fallback: { midiNote: MidiValue; glideTime: number } | null = null;
    for (const action of this.#allocator.noteOff(midiNote)) {
      const voice = action.voice as SampleVoice;
      if (action.type === 'retune') {
        voice.retune(action.midiNote, secondsFromNow, action.glideTime);
        this.prevMidiNote = action.midiNote;
        fallback = { midiNote: action.midiNote, glideTime: action.glideTime };
      } else voice.release({ secondsFromNow });
    }

    return fallback;
  }

  allNotesOff() {
    this.#allVoices.forEach((voice) => {
      if (voice.state === VoiceState.PLAYING) {
        voice.release();
      }
    });

    return this;
  }

  applyToAllVoices(fn: (voice: SampleVoice) => void) {
    this.#allVoices.forEach((voice) => fn(voice));
  }

  applyToActiveVoices(fn: (voice: SampleVoice) => void) {
    this.#allVoices.forEach((voice) => {
      if (voice.state !== VoiceState.AVAILABLE) fn(voice);
    });
  }

  applyToInactiveVoices(fn: (voice: SampleVoice) => void) {
    this.#allVoices.forEach((voice) => {
      if (voice.state === VoiceState.AVAILABLE) fn(voice);
    });
  }

  applyToActiveNote(midiNote: MidiValue, fn: (voice: SampleVoice) => void) {
    const voices = this.#allVoices.filter(
      (voice) => voice.state !== VoiceState.AVAILABLE && voice.midiNote === midiNote,
    );
    if (!voices.length) {
      console.warn(`No active voice found for midiNote: ${midiNote}`);
      return;
    }
    voices.forEach(fn);
  }

  debug() {
    const releasing = this.releasingVoicesCount;
    const playing = this.playingVoicesCount;
    const available = this.availableVoicesCount;
    console.debug(
      `
      releasing: ${releasing}
      playing: ${playing}
      available: ${available}
      Sum: ${releasing + playing + available}
      Sum should be: ${this.allVoicesCount}
      `,
    );
  }

  dispose() {
    this.applyToAllVoices((voice) => voice.dispose());
    this.#allocator.clear();
    this.#allVoices = [];
    this.#allocator.voices = [];
    this.#loaded.clear();
    this.#initialized = false;
    this.#initPromise = null;
    unregisterNode(this.nodeId);
  }

  get initialized() {
    return this.#initialized;
  }

  get playingVoicesCount() {
    return this.#allVoices.filter((voice) => voice.state === VoiceState.PLAYING).length;
  }

  get releasingVoicesCount() {
    return this.#allVoices.filter((voice) => voice.state === VoiceState.RELEASING).length;
  }

  get availableVoicesCount() {
    return this.#allVoices.filter((voice) => voice.state === VoiceState.AVAILABLE).length;
  }

  get allVoices() {
    return this.#allVoices;
  }

  get allVoicesCount() {
    return this.#allVoices.length;
  }
}
