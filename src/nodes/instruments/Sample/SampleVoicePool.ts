import { SampleVoice, type SampleVoiceChainNode } from "./SampleVoice";
import { registerNode, unregisterNode, NodeID } from "@/nodes/node-store";
import { VoiceState } from "../VoiceState";
import { Message, MessageHandler, MessageBus, createMessageBus } from "@/events";
import { GainStages, LibNode } from "@/nodes/LibNode";
import { createSampleVoices } from "./createSampleVoice";
import {
  SAMPLE_ENVELOPE_IDS,
  getSampleEnvelopeEventType,
  getSampleEnvelopeEventTypes,
} from "./temporary-sample-envelope-adapters";

export class SampleVoicePool implements LibNode {
  readonly nodeId: NodeID;
  readonly nodeType = "pool";
  #messages: MessageBus<Message>;
  #context: AudioContext;
  #initialized = false;
  #initPromise: Promise<void> | null = null;
  #polyphony: number;
  #voiceSignalChain?: readonly SampleVoiceChainNode[];

  #allVoices: SampleVoice[] = [];
  #loaded = new Set<NodeID>();

  constructor(
    context: AudioContext,
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

  sendUpstreamMessage(type: string, data: any) {
    this.#messages.sendMessage(type, data);
    return this;
  }

  #initializedVoices = new Set<SampleVoice>();
  #envelopeCreatedMap = new Map<string, Set<SampleVoice>>();

  #setupMessageHandling(voice: SampleVoice) {
    voice.onMessage("voice:initialized", (msg: Message) => {
      this.#initializedVoices.add(msg.voice);

      if (this.#initializedVoices.size === this.#allVoices.length) {
        // All voices initialized message
        this.sendUpstreamMessage("voice-pool:initialized", {
          voiceCount: this.#allVoices.length,
        });
      }
    });

    // Envelope creation tracking
    SAMPLE_ENVELOPE_IDS.forEach((envType) => {
      const createdEvent = getSampleEnvelopeEventType(envType, "created");
      voice.onMessage(createdEvent, (msg: Message) => {
        if (!this.#envelopeCreatedMap.has(envType)) {
          this.#envelopeCreatedMap.set(envType, new Set());
        }
        const set = this.#envelopeCreatedMap.get(envType)!;
        set.add(msg.voice);
        if (set.size === this.#allVoices.length) {
          // All voices have created this envelope type
          this.sendUpstreamMessage(createdEvent, {
            envType,
            voiceCount: this.#allVoices.length,
          });
        }
      });
    });

    this.#messages.forwardFrom(
      voice,
      [
        "voice:initialized",
        "voice:started",
        "voice:stopped",
        "voice:releasing",
        "voice:loaded",

        ...getSampleEnvelopeEventTypes(),
      ],
      (msg) => {
        if (msg.type === "voice:loaded") {
          this.#loaded.add(msg.senderId);

          // Only send 'sample:loaded' when all voices are loaded
          if (this.#loaded.size === this.#allVoices.length) {
            return { ...msg, type: "sample:loaded" };
          }
          return null;
        }
        return msg;
      },
    );
  }

  setLayers(buffers: AudioBuffer[], zeroCrossings?: number[]) {
    // Reset loaded voices tracking for new buffer set
    this.#loaded.clear();
    this.#allVoices.forEach((voice) => voice.loadLayers(buffers, zeroCrossings));
    return this;
  }

  #oldestVoice(state: VoiceState): SampleVoice | undefined {
    return this.#allVoices
      .filter((voice) => voice.state === state)
      .reduce<SampleVoice | undefined>(
        (oldest, voice) =>
          !oldest || voice.triggerTimestamp < oldest.triggerTimestamp ? voice : oldest,
        undefined,
      );
  }

  allocate(): SampleVoice | undefined {
    const voice =
      this.#allVoices.find((candidate) => candidate.state === VoiceState.AVAILABLE) ??
      this.#oldestVoice(VoiceState.RELEASING) ??
      this.#oldestVoice(VoiceState.PLAYING);

    if (!voice) {
      console.warn("Could not allocate voice");
      return;
    }

    if (voice.state !== VoiceState.AVAILABLE) voice.stop();

    return voice;
  }

  prevMidiNote = 60;

  noteOn(
    midiNote: MidiValue,
    velocity: MidiValue = 100,
    secondsFromNow = 0,
    glideTime = 0,
  ): MidiValue | null {
    const voice = this.allocate();
    if (!voice) return null;

    const success = voice.trigger({
      midiNote,
      velocity,
      secondsFromNow,
      glide: { prevMidiNote: this.prevMidiNote, glideTime },
    });
    if (success === null) return null;

    this.#allVoices.forEach((otherVoice) => {
      if (
        otherVoice !== voice &&
        otherVoice.state === VoiceState.PLAYING &&
        otherVoice.midiNote === midiNote
      ) {
        otherVoice.release({ secondsFromNow });
      }
    });
    this.prevMidiNote = midiNote;
    return midiNote;
  }

  noteOff(midiNote: MidiValue, secondsFromNow: number = 0, releaseTime?: number) {
    const voices = this.#allVoices.filter(
      (voice) => voice.state === VoiceState.PLAYING && voice.midiNote === midiNote,
    );
    if (!voices.length) return;

    voices.forEach((voice) => voice.release({ secondsFromNow, releaseTime }));

    return this;
  }

  allNotesOff(releaseTime = 0) {
    this.#allVoices.forEach((voice) => {
      if (voice.state === VoiceState.PLAYING || voice.state === VoiceState.RELEASING) {
        voice.release({ releaseTime });
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
