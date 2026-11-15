import { SampleVoice, type SampleVoiceChainNode } from './SampleVoice';
import { registerNode, unregisterNode, NodeID } from '@/nodes/node-store';
import { VoiceState } from '../VoiceState';
import { Message, MessageHandler, MessageBus, createMessageBus } from '@/events';
import { GainStages, LibNode } from '@/nodes/LibNode';
import { createSampleVoices } from './createSampleVoice';

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
  #legato: LegatoSettings = { mode: 'off' };
  #noteId = 0;

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
          // Voices sharing an id form one pool on the audio thread, which allocates.
          processorOptions: { poolId: this.nodeId },
        });
        this.#post({ type: 'pool:setLegato', value: this.#legato });

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
        'voice:retuned',
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
        if (msg.type === 'voice:retuned' && msg.fallback) this.prevMidiNote = msg.midiNote;
        return msg;
      },
    );
  }

  setBuffer(buffer: AudioBuffer, zeroCrossings?: number[]) {
    // Reset loaded voices tracking for new buffer
    this.#loaded.clear();
    this.allNotesOff(); // notes scheduled on the old buffer go with it
    this.#allVoices.forEach((voice) => voice.loadBuffer(buffer, zeroCrossings));
    return this;
  }

  /** Any voice's port reaches the pool on the audio thread. */
  #post(message: object) {
    this.#allVoices[0]?.sendToProcessor(message);
  }

  prevMidiNote = 60;

  get legato(): LegatoSettings {
    return this.#legato;
  }

  set legato(settings: LegatoSettings) {
    this.#legato = settings;
    this.#post({ type: 'pool:setLegato', value: settings });
  }

  /**
   * Queues the note for the audio thread, which picks the voice when the note
   * is due. What it decided comes back as `voice:started` or `voice:retuned`.
   * Null when no audio is loaded.
   */
  noteOn(
    midiNote: MidiValue,
    velocity: MidiValue = 100,
    secondsFromNow = 0,
    glideTime = 0,
  ): MidiValue | null {
    const voice = this.#allVoices[0];
    if (!voice?.hasLoadedAudio) return null;
    this.#post({
      type: 'pool:noteOn',
      triggerId: ++this.#noteId,
      // ponytail: every voice shares one pitch setting, so any voice can work out the
      // note's rate. Per-voice tuning means the audio thread computing it per voice.
      ...voice.noteMessage({
        midiNote,
        velocity,
        secondsFromNow,
        glide: { fromMidiNote: this.prevMidiNote, seconds: glideTime },
      }),
    });
    this.prevMidiNote = midiNote;
    return midiNote;
  }

  /** A legato voice falling back to an earlier held note reports `voice:retuned` with `fallback`. */
  noteOff(midiNote: MidiValue, secondsFromNow: number = 0) {
    this.#post({
      type: 'pool:noteOff',
      midiNote,
      timestamp: this.#context.currentTime + secondsFromNow,
    });
  }

  /** Releases every held note and drops the ones still waiting to sound. */
  allNotesOff() {
    this.#post({ type: 'pool:allNotesOff', timestamp: this.#context.currentTime });
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
    this.#post({ type: 'pool:dispose' });
    this.applyToAllVoices((voice) => voice.dispose());
    this.#allVoices = [];
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
