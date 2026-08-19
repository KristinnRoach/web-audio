import { LibNode, NodeType } from "./LibNode";
import { registerNode, unregisterNode, NodeID } from "./node-store";
import { MessageBus, MessageHandler, Message, createMessageBus } from "@/events";
import { InstrumentBus } from "./master/InstrumentBus";

/** Adapter interface for web native and Audiolib's custom audio nodes */
export interface ILibAudioNode<T extends AudioNode | AudioWorkletNode = AudioNode> extends LibNode {
  // Connection interface
  connect(destination: ILibAudioNode | AudioNode): void;
  disconnect(destination?: ILibAudioNode | AudioNode): void;

  // Parameter interface
  setParam(name: string, value: number, time?: number): void;
  getAudioParam(name: string): AudioParam | null;

  // Messaging
  onMessage?(type: string, handler: MessageHandler<Message>): () => void;

  // Convenience getters
  readonly now: number;
  readonly audioNode: T;
  readonly context: AudioContext | BaseAudioContext;

  readonly connections: {
    outgoing: NodeID[];
    incoming: NodeID[];
  };

  // Input/output access
  readonly input: AudioNode;
  readonly output: AudioNode;
}

/** Extends ILibAudioNode with core Instrument features */
export interface ILibInstrumentNode extends ILibAudioNode {
  // Core instrument capabilities
  play(midiNote: MidiValue, velocity?: number): MidiValue | null;
  release(note: MidiValue): this;
  releaseAll(releaseTime?: number): this;

  // sustainPedalOn(): this;
  // sustainPedalOff(): this;

  outBus?: InstrumentBus;
}

export interface LibAudioNodeOptions {
  createIOGains?: boolean;
}

export class LibAudioNode<
  T extends AudioNode | AudioWorkletNode = AudioNode,
> implements ILibAudioNode<T> {
  readonly nodeId: NodeID;
  readonly nodeType: NodeType;
  #messages: MessageBus<Message>;
  #initialized = false;

  #audioNode: T;

  #inputNode: AudioNode | AudioWorkletNode;
  #outputNode: AudioNode | AudioWorkletNode;

  #connections = new Set<NodeID>();
  #incoming = new Set<NodeID>();

  constructor(
    node: T,
    context: AudioContext,
    nodeType: NodeType,
    options: LibAudioNodeOptions = {},
  ) {
    this.nodeType = nodeType;
    this.nodeId = registerNode(nodeType, this);
    this.#messages = createMessageBus<Message>(this.nodeId);

    this.#audioNode = node;

    if (options.createIOGains) {
      this.#inputNode = new GainNode(context, { gain: 1 });
      this.#outputNode = new GainNode(context, { gain: 1 });
      this.#inputNode.connect(this.#audioNode);
      this.#audioNode.connect(this.#outputNode);
    } else {
      this.#inputNode = node;
      this.#outputNode = node;
    }

    this.#initialized = true;
  }

  // === MESSAGING ===

  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  sendUpstreamMessage(type: string, data: any): this {
    this.#messages.sendMessage(type, data);
    return this;
  }

  // === CONNECTIONS ===

  connect(destination: ILibAudioNode | AudioNode): void {
    const target = "input" in destination ? destination.input : destination;
    this.#outputNode.connect(target as AudioNode);

    // Track by NodeID if it's a LibAudioNode
    if ("nodeId" in destination) {
      this.#connections.add(destination.nodeId);
      (destination as any).addIncoming?.(this.nodeId);
    }
  }

  disconnect(destination?: ILibAudioNode | AudioNode): void {
    if (destination) {
      const target = "input" in destination ? destination.input : destination;
      this.#outputNode.disconnect(target as AudioNode);

      if ("nodeId" in destination) {
        this.#connections.delete(destination.nodeId);
        (destination as any).removeIncoming?.(this.nodeId);
      }
    } else {
      // Disconnect all
      this.#outputNode.disconnect();
      this.#connections.clear();
    }
  }

  addIncoming(sourceNodeId: NodeID): void {
    this.#incoming.add(sourceNodeId);
  }

  removeIncoming(sourceNodeId: NodeID): void {
    this.#incoming.delete(sourceNodeId);
  }

  get connections() {
    return {
      outgoing: Array.from(this.#connections),
      incoming: Array.from(this.#incoming),
    };
  }

  // === PARAMS ===

  setParam(name: string, value: number, timestamp = this.now): void {
    // Try AudioWorkletNode parameters first
    if ("parameters" in this.#audioNode) {
      const param = (this.#audioNode as AudioWorkletNode).parameters.get(name);
      if (param) {
        param.setValueAtTime(value, timestamp);
        return;
      }
    }

    // Try direct AudioNode properties
    const param = (this.#audioNode as any)[name];
    if (param?.setValueAtTime) {
      param.setValueAtTime(value, timestamp);
      return;
    }

    console.warn(`Parameter '${name}' not found on node`);
  }

  getAudioParam(name: string): AudioParam | null {
    return (this.#audioNode as any)[name] || null;
  }

  // === CONVENIANCE GETTERS ===

  get audioNode(): T {
    return this.#audioNode;
  }
  get input() {
    return this.#inputNode;
  }
  get output() {
    return this.#outputNode;
  }
  get context() {
    return this.#audioNode.context;
  }
  get now() {
    return this.#audioNode.context.currentTime;
  }
  get initialized() {
    return this.#initialized;
  }

  dispose() {
    this.disconnect();
    unregisterNode(this.nodeId);
  }
}
