// InstrumentMasterBus.ts

import { ILibAudioNode, LibAudioNode } from "@/nodes/LibAudioNode";
import { registerNode, NodeID, unregisterNode } from "@/nodes/node-store";
import { getAudioContext } from "@/context";

import { Message, MessageBus, MessageHandler, createMessageBus } from "@/events";

import { clamp, mapToRange } from "@/utils";

import { DEFAULT_COMPRESSOR_SETTINGS, DEFAULT_LIMITER_SETTINGS } from "./defaults";

import { LevelMonitor } from "@/utils/audiodata/monitoring/LevelMonitor";
import { DattorroReverb } from "@/nodes/effects/DattorroReverb";
import { HarmonicFeedback } from "../effects/HarmonicFeedback";

import { createDelay, createDistortion } from "@/worklets/worklet-factory";
import { DelayWorklet, DistortionWorklet } from "@/worklets/worklet-types";
import { WorkletNode } from "@/worklets/WorkletNode";

export type BusNodeName =
  // Main mix nodes
  | "input"
  | "output"
  | "dryMix"
  | "wetMix"
  | "hpf"
  | "lpf"
  // Effect nodes
  | "distortion"
  | "feedback"
  | "reverb"
  | "compressor"
  | "limiter"
  | "delay";

export type BusSendName = `${BusNodeName}_send`;

type BusNodeTypeMap = {
  input: ILibAudioNode<GainNode>;
  lpf: ILibAudioNode<BiquadFilterNode>;
  hpf: ILibAudioNode<BiquadFilterNode>;
  dryMix: ILibAudioNode<GainNode>;
  wetMix: ILibAudioNode<GainNode>;
  output: ILibAudioNode<GainNode>;
  compressor: ILibAudioNode<DynamicsCompressorNode>;
  limiter: ILibAudioNode<DynamicsCompressorNode>;
  feedback: HarmonicFeedback;
  distortion: ILibAudioNode<DistortionWorklet>;
  reverb: DattorroReverb;
  delay?: ILibAudioNode<DelayWorklet>;
};

export class InstrumentBus implements ILibAudioNode {
  readonly nodeId: NodeID;
  readonly nodeType = "InstrumentBus";
  #messages: MessageBus<Message>;
  #context: AudioContext;
  #initialized = false;
  #initPromise: Promise<void> | null = null;

  #nodes: Partial<BusNodeTypeMap> = {};
  #internalRouting = new Map<string, string[]>();

  #sendNodes = new Map<BusNodeName, ILibAudioNode<GainNode>>();

  #outgoingConnections = new Set<NodeID>();
  #incomingConnections = new Set<NodeID>();

  constructor(context?: AudioContext) {
    this.nodeId = registerNode(this.nodeType, this);
    this.#context = context || getAudioContext();
    this.#messages = createMessageBus(this.nodeId);
  }

  createGainNode(
    context: AudioContext,
    options: { initialGain?: number } = {},
  ): ILibAudioNode<GainNode> {
    const { initialGain = 1 } = options;

    return new LibAudioNode<GainNode>(
      new GainNode(this.#context, { gain: initialGain }),
      context,
      "gain",
    );
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      try {
        // Create nodes
        const input = this.createGainNode(this.#context, { initialGain: 1 });
        const dryMix = this.createGainNode(this.#context, { initialGain: 1 });
        const wetMix = this.createGainNode(this.#context, { initialGain: 1 });
        const output = this.createGainNode(this.#context, { initialGain: 1 });

        const lpf = new LibAudioNode<BiquadFilterNode>(
          new BiquadFilterNode(this.#context, {
            type: "lowpass",
            Q: 0.5,
            frequency: this.#context.sampleRate / 2 - 1000,
          }),
          this.#context,
          "lpf",
        );

        const hpf = new LibAudioNode<BiquadFilterNode>(
          new BiquadFilterNode(this.#context, {
            type: "highpass",
            Q: 0.707,
            frequency: 20,
          }),
          this.#context,
          "hpf",
        );

        const compressor = new LibAudioNode<DynamicsCompressorNode>(
          new DynamicsCompressorNode(this.#context, DEFAULT_COMPRESSOR_SETTINGS),
          this.#context,
          "compressor",
        );

        const limiter = new LibAudioNode<DynamicsCompressorNode>(
          new DynamicsCompressorNode(this.#context, DEFAULT_LIMITER_SETTINGS),
          this.#context,
          "limiter",
        );

        const distortion = new LibAudioNode<DistortionWorklet>(
          createDistortion(this.#context),
          this.#context,
          "distortion",
        );

        const delay = new LibAudioNode<DelayWorklet>(
          createDelay(this.#context),
          this.#context,
          "Delay",
          { createIOGains: false },
        );

        // Nodes that already implement ILibAudioNode
        const reverb = new DattorroReverb(this.#context);
        const feedback = new HarmonicFeedback(this.#context);

        // Add to Map
        this.#addNodes({
          input,
          lpf,
          hpf,
          dryMix,
          wetMix,
          output,
          compressor,
          limiter,
          feedback,
          distortion,
          reverb,
          delay,
        });

        // Create sends
        this.#createSendNode("reverb");
        this.#createSendNode("delay");

        this.#setupDefaultRouting();
        // this.debugRouting(); // Uncomment for debugging

        this.#initialized = true;
      } catch {}
    })();
    return this.#initPromise;
  }

  // === ROUTING ===

  #connectChain = (chain: Array<BusNodeName | BusSendName>): this => {
    for (let i = 0; i < chain.length - 1; i++) {
      this.#connectFromTo(chain[i], chain[i + 1]);
    }
    return this;
  };

  #setupDefaultRouting(): void {
    // Dry chain
    this.#connectChain(["input", "hpf", "feedback", "dryMix"]);

    // Delay chain
    this.#connectChain(["feedback", "delay_send", "delay", "wetMix"]);

    this.#connectChain(["delay", "reverb_send"]);

    // Reverb chain
    this.#connectChain(["feedback", "reverb_send", "reverb", "wetMix"]);

    // Combine chains
    this.#connectChain(["wetMix", "distortion"]);
    this.#connectFromTo("dryMix", "distortion");

    // Shared output chain
    this.#connectChain(["distortion", "compressor", "lpf", "limiter", "output"]);
  }

  #connectFromTo(from: BusNodeName | BusSendName, to: BusNodeName | BusSendName): this {
    const fromNode = from.endsWith("_send")
      ? this.getNode(from as BusSendName)
      : this.getNode(from as BusNodeName);

    const toNode = to.endsWith("_send")
      ? this.getNode(to as BusSendName)
      : this.getNode(to as BusNodeName);

    if (!fromNode || !toNode) {
      console.warn(`Cannot connect ${from} -> ${to}: node not found`);
      return this;
    }

    fromNode.connect(toNode);

    // Track connection
    const connections = this.#internalRouting.get(from) || [];
    if (!connections.includes(to)) {
      connections.push(to);
      this.#internalRouting.set(from, connections);
    }

    return this;
  }

  #disconnectFromTo(from: string, to?: string): this {
    const fromNode = this.#nodes[from as keyof BusNodeTypeMap];
    if (!fromNode) return this;

    if (to) {
      const toNode = this.#nodes[to as keyof BusNodeTypeMap];
      if (toNode) {
        fromNode.disconnect(toNode);

        // Update tracking
        const connections = this.#internalRouting.get(from) || [];
        const index = connections.indexOf(to);
        if (index > -1) {
          connections.splice(index, 1);
          this.#internalRouting.set(from, connections);
        }
      }
    } else {
      // Disconnect all
      fromNode.disconnect();
      this.#internalRouting.set(from, []);
    }

    return this;
  }

  // === NODE MGMT ===

  #createSendNode = (
    nodeName: BusNodeName,
    options: { initGain?: number } = {},
  ): ILibAudioNode<GainNode> => {
    const { initGain = 0.0 } = options;
    const node = new LibAudioNode<GainNode>(
      new GainNode(this.#context, { gain: initGain }),
      this.#context,
      "gain",
    );
    this.#sendNodes.set(nodeName, node);
    return node;
  };

  getNode<K extends BusNodeName>(name: K): BusNodeTypeMap[K];
  getNode(name: BusSendName): ILibAudioNode<GainNode> | undefined;
  getNode(name: BusNodeName | BusSendName): any {
    if (name.endsWith("_send")) {
      const node = name.replace("_send", "") as BusNodeName;
      return this.#sendNodes.get(node);
    }
    return this.#nodes[name as keyof BusNodeTypeMap];
  }

  getSendNode = (name: BusNodeName) => this.#sendNodes.get(name);

  #addNode<K extends keyof BusNodeTypeMap>(name: K, node: BusNodeTypeMap[K]): void {
    this.#nodes[name] = node;
    this.#internalRouting.set(name as string, []);
  }

  #addNodes(nodes: Partial<BusNodeTypeMap>): this {
    (Object.keys(nodes) as Array<keyof BusNodeTypeMap>).forEach((name) => {
      const node = nodes[name];
      if (node !== undefined) {
        this.#addNode(name, node);
      }
    });
    return this;
  }

  removeNode(name: string): this {
    const node = this.#nodes[name as keyof BusNodeTypeMap];
    if (node) {
      // Disconnect everything
      this.#disconnectFromTo(name);

      // Remove from other connections
      for (const [fromName, connections] of this.#internalRouting) {
        const index = connections.indexOf(name);
        if (index > -1) {
          connections.splice(index, 1);
          this.#internalRouting.set(fromName, connections);
        }
      }

      // Clean up
      delete this.#nodes[name as keyof BusNodeTypeMap];
      this.#internalRouting.delete(name);
    }

    return this;
  }

  // === NOTE ON/OFF ===

  noteOn(midiNote: number, velocity: number = 100, secondsFromNow = 0, glideTime = 0): this {
    const feedback = this.getNode("feedback");
    if (feedback && "trigger" in feedback && typeof feedback.trigger === "function") {
      feedback.trigger(midiNote, {
        velocity,
        secondsFromNow,
        glideTime,
      });
    }

    const delayNode = this.getNode("delay");
    delayNode?.audioNode.sendProcessorMessage({ type: "trigger" });

    return this;
  }

  // === PARAMS ===

  setSendAmount(effect: BusNodeName, amount: number): this {
    const sendNode = this.#sendNodes.get(effect);

    if (!sendNode) {
      console.warn(`Send effect ${effect} not found`);
      return this;
    }

    const safeAmount = Math.max(0, Math.min(1, amount));
    sendNode.setParam("gain", safeAmount);

    return this;
  }

  setHpfCutoff(hz: number): this {
    const safeHz = clamp(hz, 20, this.context.sampleRate / 2 - 1000);
    this.getNode("hpf")?.audioNode.frequency.setTargetAtTime(safeHz, this.now, 0.1);
    return this;
  }

  setLpfCutoff(hz: number): this {
    const safeHz = clamp(hz, 20, this.context.sampleRate / 2 - 1000);
    this.getNode("lpf")?.audioNode.frequency.setTargetAtTime(safeHz, this.now, 0.1);
    return this;
  }

  setCompressorParams(params: {
    threshold?: number;
    knee?: number;
    ratio?: number;
    attack?: number;
    release?: number;
  }): this {
    const node = this.getNode("compressor")?.audioNode;

    if (params.threshold !== undefined) {
      node.threshold.setValueAtTime(params.threshold, this.now);
    }
    if (params.knee !== undefined) {
      node.knee.setValueAtTime(params.knee, this.now);
    }
    if (params.ratio !== undefined) {
      node.ratio.setValueAtTime(params.ratio, this.now);
    }
    if (params.attack !== undefined) {
      node.attack.setValueAtTime(params.attack, this.now);
    }
    if (params.release !== undefined) {
      node.release.setValueAtTime(params.release, this.now);
    }

    return this;
  }

  setDryWetMix(mix: { dry: number; wet: number }): this {
    if (mix.dry !== undefined) {
      const safeDry = Math.max(0, Math.min(1, mix.dry));
      this.getNode("dryMix")?.setParam("gain", safeDry);
    }

    if (mix.wet !== undefined) {
      const safeWet = Math.max(0, Math.min(1, mix.wet));
      this.getNode("wetMix")?.setParam("gain", safeWet);
    }

    return this;
  }

  setDelayTime(seconds: number): this {
    const safeTime = clamp(seconds, 0, 5.0);
    this.getNode("delay")?.setParam("delayTime", safeTime);

    return this;
  }

  setDelayFeedback(amount: number): this {
    const safeAmount = mapToRange(amount, 0, 1, 0, 0.99);
    this.getNode("delay")?.setParam("feedbackAmount", safeAmount);
    return this;
  }

  /**
   * Set the character modes for the delay processor, in the order in which to process (e.g. ['filtered', 'bitCrushed'])
   */
  setDelayCharacter(modes: Array<"clean" | "bitCrushed" | "filtered">): this {
    const delayNode = this.getNode("delay");
    delayNode?.audioNode.sendProcessorMessage({ type: "setCharacter", modes });
    return this;
  }

  setReverbSize(amount: number): this {
    const reverb = this.getNode("reverb");
    if (reverb && "setAmountMacro" in reverb && typeof reverb.setAmountMacro === "function") {
      reverb.setAmountMacro(amount);
    }
    return this;
  }

  setReverbDecay(decay: number) {
    this.getNode("reverb")?.setParam("decay", decay);
    return this;
  }

  setDistortionMacro(amount: number) {
    const safeAmount = clamp(amount, 0, 1);
    this.setDrive(safeAmount);

    const tamedForClip = mapToRange(safeAmount, 0, 1, 0, 0.95);
    this.setClippingMacro(tamedForClip);
  }

  setDrive(amount: number) {
    this.getNode("distortion")?.setParam("distortionDrive", amount);
    return this;
  }

  setClippingMacro(amount: number) {
    const safeAmount = clamp(amount, 0, 1);
    const distortion = this.getNode("distortion");
    distortion?.setParam("clippingAmount", safeAmount);

    const clipThreshold = mapToRange(safeAmount, 0, 1, 0.25, 0.03);

    distortion?.setParam("clippingThreshold", clipThreshold);
    return this;
  }

  setClippingMode(mode: "soft-clipping" | "hard-clipping") {
    const distortion = this.getNode("distortion");
    if (distortion instanceof WorkletNode) {
      distortion.sendProcessorMessage({
        type: "setLimitingMode",
        mode: mode,
      });
    }
  }

  setFeedbackAmount(amount: number) {
    const feedback = this.getNode("feedback");
    if (feedback && "setAmountMacro" in feedback && typeof feedback.setAmountMacro === "function") {
      feedback.setAmountMacro(amount);
    }
    return this;
  }

  setFeedbackPitchScale(value: number) {
    const feedback = this.getNode("feedback");
    if (
      feedback &&
      "setDelayMultiplier" in feedback &&
      typeof feedback.setDelayMultiplier === "function"
    ) {
      feedback.setDelayMultiplier(value);
    }
    return this;
  }

  setFeedbackDecay(amount: number) {
    this.getNode("feedback")?.setDecay(amount);
    return this;
  }

  setFeedbackLowpassCutoff(amount: number) {
    this.getNode("feedback")?.setLowpassCutoff(amount);
    return this;
  }

  connect(destination: ILibAudioNode | AudioNode): void {
    this.getNode("output").connect(destination);

    if ("nodeId" in destination) {
      this.#outgoingConnections.add(destination.nodeId);
      (destination as any).addIncoming?.(this.nodeId);
    }
  }

  disconnect(destination?: ILibAudioNode | AudioNode): void {
    this.getNode("output").disconnect(destination);

    if (destination && "nodeId" in destination) {
      this.#outgoingConnections.delete(destination.nodeId);
      (destination as any).removeIncoming?.(this.nodeId);
    } else if (!destination) {
      this.#outgoingConnections.clear();
    }
  }

  addIncoming(sourceNodeId: NodeID): void {
    this.#incomingConnections.add(sourceNodeId);
  }

  removeIncoming(sourceNodeId: NodeID): void {
    this.#incomingConnections.delete(sourceNodeId);
  }

  setParam(name: string, value: number): void {
    switch (name) {
      case "outputLevel":
        this.outputLevel = value;
        break;
      case "reverbAmount":
        this.setReverbSize(value);
        break;
      case "feedbackAmount":
        this.setFeedbackAmount(value);
        break;
      case "feedbackDecay":
        this.setFeedbackDecay(value);
        break;
      case "drive":
        this.setDrive(value);
        break;
      case "hpfCutoff":
        this.setHpfCutoff(value);
        break;
      case "lpfCutoff":
        this.setLpfCutoff(value);
        break;
      default:
        console.warn(`Parameter '${name}' not recognized on InstrumentMasterBus`);
        break;
    }
  }

  getAudioParam(name: string): AudioParam | null {
    switch (name) {
      case "outputLevel":
        return this.getNode("output").getAudioParam("gain");
      case "hpfCutoff":
        return this.getNode("hpf")?.getAudioParam("frequency") || null;
      case "lpfCutoff":
        return this.getNode("lpf")?.getAudioParam("frequency") || null;
      default:
        return null;
    }
  }

  // Convenience node getters
  getInput() {
    return this.getNode("input");
  }
  getOutput() {
    return this.getNode("output");
  }
  getLpf() {
    return this.getNode("lpf");
  }
  getHpf() {
    return this.getNode("hpf");
  }
  getDryMix() {
    return this.getNode("dryMix");
  }
  getWetMix() {
    return this.getNode("wetMix");
  }
  getCompressor() {
    return this.getNode("compressor");
  }
  getLimiter() {
    return this.getNode("limiter");
  }
  getDistortion() {
    return this.getNode("distortion");
  }
  getReverb() {
    return this.getNode("reverb");
  }
  getFeedback() {
    return this.getNode("feedback");
  }

  dispose(): void {
    // Disconnect all nodes
    for (const name of Object.keys(this.#nodes)) {
      this.#disconnectFromTo(name);
    }

    // Clear all maps
    this.#nodes = {};
    this.#internalRouting.clear();
    this.#sendNodes.clear();

    unregisterNode(this.nodeId);
  }

  // Accessors - now perfectly typed without casts!
  get audioNode(): GainNode {
    return this.getNode("output").audioNode;
  }

  get context(): AudioContext {
    return this.#context;
  }

  get connections() {
    return {
      outgoing: Array.from(this.#outgoingConnections),
      incoming: Array.from(this.#incomingConnections),
    };
  }

  get input(): GainNode {
    return this.getNode("input")?.audioNode;
  }

  get output(): GainNode {
    return this.getNode("output")?.audioNode;
  }

  get now(): number {
    return this.#context.currentTime;
  }

  set outputLevel(level: number) {
    const safeValue = Math.max(0, Math.min(1, level));
    this.getNode("output").setParam("gain", safeValue);
  }

  get outputLevel(): number {
    const param = this.getNode("output").getAudioParam("gain");
    return param?.value || 0;
  }

  // Compatibility getters
  get initialized(): boolean {
    return this.#initialized;
  }

  get dryWetMix(): { dry: number; wet: number } {
    return {
      dry: this.getNode("dryMix")?.getAudioParam("gain")?.value || 0,
      wet: this.getNode("wetMix")?.getAudioParam("gain")?.value || 0,
    };
  }

  getSendAmount(effect: BusNodeName): number {
    const sendNode = this.#sendNodes.get(effect);
    return sendNode?.getAudioParam("gain")?.value ?? 0;
  }

  // Debug methods
  getRoutingMap(): Record<string, string[]> {
    const routing: Record<string, string[]> = {};
    for (const [from, connections] of this.#internalRouting) {
      routing[from] = [...connections];
    }
    return routing;
  }

  debugRouting(): void {
    console.debug("=== Bus Routing Map ===");
    for (const [from, connections] of this.#internalRouting) {
      if (connections.length > 0) {
        console.debug(`${from} -> ${connections.join(", ")}`);
      }
    }
    console.debug("======================");
  }

  debugSends(): void {
    console.debug("=== Sends ===");
    for (const [effect] of this.#sendNodes) {
      const sendAmount = this.getSendAmount(effect);
      console.debug(`${effect}: Send=${sendAmount.toFixed(2)}}`);
    }
    console.debug("=================================");
  }

  listNodes(): string[] {
    return Object.keys(this.#nodes);
  }

  // Level monitoring
  #levelMonitor: LevelMonitor | null = null;

  startLevelMonitoring(
    intervalMs: number = 1000,
    fftSize: number = 1024,
    logOutput: boolean = false,
  ): void {
    this.stopLevelMonitoring();

    this.#levelMonitor = new LevelMonitor(
      this.#context,
      this.getNode("input").audioNode,
      this.getNode("output").audioNode,
      fftSize,
    );
    this.#levelMonitor.start(intervalMs, undefined, logOutput);
    console.log("Level monitoring started");
  }

  stopLevelMonitoring(): void {
    if (this.#levelMonitor) {
      this.#levelMonitor.stop();
      this.#levelMonitor = null;
      console.log("Level monitoring stopped");
    }
  }

  logLevels(): void {
    let monitor = this.#levelMonitor;
    if (monitor === null) {
      monitor = new LevelMonitor(
        this.#context,
        this.getNode("input").audioNode,
        this.getNode("output").audioNode,
      );
    }
    const levels = monitor.getLevels();
    console.log(
      `Levels: Input RMS ${levels.input.rmsDB.toFixed(1)} dB | Output RMS ${levels.output.rmsDB.toFixed(1)} dB`,
    );
  }

  // Message handling
  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }
}
