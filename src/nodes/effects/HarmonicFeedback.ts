import { ILibAudioNode } from '../LibAudioNode';
import { NodeType } from '@/nodes/LibNode';
import { getAudioContext } from '@/context';
import { registerNode, unregisterNode } from '@/nodes/node-store';
import { clamp, interpolate, mapToRange } from '@/utils';
import { createFeedbackDelay } from '@/worklets/worklet-factory';
import { FbDelayWorklet } from '@/worklets/worklet-types';

export class HarmonicFeedback implements ILibAudioNode {
  readonly nodeId: NodeID;
  readonly nodeType: NodeType = 'harmonic-feedback';
  #initialized = false;
  #context: AudioContext;

  #delay: FbDelayWorklet;

  #preGain: GainNode;
  #postGain: GainNode;

  #connections = new Set<NodeID>();
  #incoming = new Set<NodeID>();

  #baseDelayTime: number;
  #pitchMultiplier = 1;
  #decayActive = false;

  #MIN_FB = 0;
  #MAX_FB = 0.999;
  #MIN_DECAY = 0.15;
  #MAX_DECAY = 1;
  #MIN_DELAY_TIME = 0.00012656238799684144; // B8 natural (H) in seconds
  #MAX_DELAY_TIME = 2;

  constructor(context: AudioContext = getAudioContext()) {
    this.nodeId = registerNode(this.nodeType, this);
    this.#context = context;

    this.#delay = createFeedbackDelay(context);

    this.#preGain = new GainNode(context, { gain: 1 });
    this.#postGain = new GainNode(context, { gain: 1 });

    // Signal path: preGain -> delay ->  postGain
    this.#preGain.connect(this.#delay).connect(this.#postGain);

    const initDelayTime = this.setPitch(60);
    this.#baseDelayTime = initDelayTime;

    this.#initialized = true;
  }

  trigger(
    midiNote: number,
    options: {
      glideTime?: number;
      velocity?: number;
      secondsFromNow?: number;
      cents?: number;
      triggerDecay?: boolean;
    } = {}
  ) {
    const {
      secondsFromNow = 0,
      cents = 0,
      velocity = 100,
      glideTime = 0,
      triggerDecay = true,
    } = options;
    const timestamp = this.now + secondsFromNow;

    this.setPitch(midiNote, cents, timestamp, glideTime);
    if (triggerDecay) this.#triggerDecay();

    return this;
  }

  // === SETTERS ===

  #currentAmount = 0;

  setAmountMacro(amount: number): this {
    const safeAmount = clamp(amount, 0, 1);

    this.setFeedbackAmount(safeAmount);

    this.#currentAmount = safeAmount;
    return this;
  }

  get currentAmount() {
    return this.#currentAmount;
  }

  setPitch(
    midiNote: number,
    cents: number = 0,
    timestamp = this.now,
    glideTime = 0
  ) {
    const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);

    const tunedFrequency =
      cents !== 0 ? frequency * Math.pow(2, cents / 1200) : frequency;

    const delaySec = 1 / tunedFrequency;

    const minDelay = this.#MIN_DELAY_TIME;
    const safeDelay = Math.max(minDelay, delaySec);

    this.setDelay(safeDelay, timestamp, glideTime);

    return safeDelay;
  }

  setDelay(seconds: number, timestamp = this.now, glideTime = 0) {
    this.#baseDelayTime = seconds;

    const scaled = seconds * this.#pitchMultiplier;
    const clamped = clamp(scaled, this.#MIN_DELAY_TIME, this.#MAX_DELAY_TIME);

    if (glideTime === 0 || !isFinite(glideTime)) {
      this.getAudioParam('delayTime')!.setValueAtTime(clamped, timestamp);
      return this;
    } else {
      this.getAudioParam('delayTime')!.linearRampToValueAtTime(
        clamped,
        timestamp + glideTime
      );
    }
    return this;
  }

  setDelayMultiplier(value: number, timestamp = this.now, glideTime = 0.75) {
    if (!(typeof value === 'number') || !isFinite(value)) {
      console.warn('setDelayMultiplier:Invalid multiplier:', value);
      return;
    }

    const safeMultiplier = clamp(value, 0.25, 4, {
      warn: true,
      name: 'pitchDelayMultiplier',
    });

    const delayParam = this.getAudioParam('delayTime')!;

    this.#pitchMultiplier = safeMultiplier;

    const newDelayTime = clamp(
      safeMultiplier * this.#baseDelayTime,
      this.#MIN_DELAY_TIME,
      this.#MAX_DELAY_TIME
    );

    if (glideTime === 0 || !isFinite(glideTime)) {
      delayParam.setValueAtTime(newDelayTime, timestamp);
      return this;
    } else {
      delayParam.setTargetAtTime(newDelayTime, timestamp, glideTime / 3);
      // divide seconds by 3 for timeConstant
    }

    return this;
  }

  setFeedbackAmount(amount: number, timestamp = this.now) {
    const interpolated = interpolate(amount, {
      inputRange: { min: 0, max: 1 },
      outputRange: { min: Math.max(0.001, this.#MIN_FB), max: this.#MAX_FB },
      curve: 'power4',
    });

    this.#delay.parameters
      .get('feedbackAmount')!
      .setValueAtTime(interpolated, timestamp);
    return this;
  }

  setAutoGain(enabled: boolean, amount: number): this {
    this.#delay.port.postMessage({
      type: 'setAutoGain',
      enabled: enabled,
      amount,
    });
    return this;
  }

  setDecay(amount: number, timestamp = this.now): this {
    const mappedAmount = mapToRange(
      amount,
      0,
      1,
      this.#MIN_DECAY,
      this.#MAX_DECAY
    );
    this.getAudioParam('decay')!.setValueAtTime(mappedAmount, timestamp);
    return this;
  }

  setLowpassCutoff(freqHz: number) {
    if (freqHz > 16000 || freqHz < 100) {
      console.warn('Feedback lowpass cutoff out of bounds');
      return;
    }

    this.getAudioParam('lowpass')!.setTargetAtTime(freqHz, this.now, 0.1);
  }

  #triggerDecay(): this {
    if (this.#decayActive) {
      this.#stopDecay();
    }

    this.#decayActive = true;
    const currentFeedbackAmount = this.getAudioParam('feedbackAmount')!.value;

    this.#delay.port.postMessage({
      type: 'triggerDecay',
      baseFeedbackAmount: currentFeedbackAmount,
    });

    return this;
  }

  #stopDecay(): this {
    this.#decayActive = false;
    this.#delay.port.postMessage({
      type: 'stopDecay',
    });
    return this;
  }

  // === CONNECTIONS ===

  connect(destination: ILibAudioNode | AudioNode): void {
    const target = 'input' in destination ? destination.input : destination;
    this.#postGain.connect(target as AudioNode);

    if ('nodeId' in destination) {
      this.#connections.add(destination.nodeId);
      (destination as any).addIncoming?.(this.nodeId);
    }
  }

  disconnect(destination?: ILibAudioNode | AudioNode): void {
    if (destination) {
      const target = 'input' in destination ? destination.input : destination;
      this.#postGain.disconnect(target as AudioNode);
      if ('nodeId' in destination) {
        this.#connections.delete(destination.nodeId);
        (destination as any).removeIncoming?.(this.nodeId);
      }
    } else {
      this.#postGain.disconnect();
      this.#connections.clear();
    }
  }

  addIncoming(source: ILibAudioNode): void {
    this.#incoming.add(source.nodeId);
  }

  removeIncoming(source: ILibAudioNode): void {
    this.#incoming.delete(source.nodeId);
  }

  // === ILibAudioNode interface ===

  setParam(name: string, value: number, time = this.now): void {
    switch (name) {
      case 'feedback':
        this.setFeedbackAmount(value, time);
        break;
      case 'delayTime':
        this.setDelay(value, time);
        break;
      case 'amount':
        this.setAmountMacro(value);
        break;
      case 'decay':
        this.setDecay(value, time);
        break;
      default:
        // Try setting on delay worklet
        this.#delay.parameters.get(name)?.setValueAtTime(value, time);
        break;
    }
  }

  getAudioParam(name: string): AudioParam | null {
    switch (name) {
      default:
        return this.#delay.parameters.get(name) || null;
    }
  }

  // === GETTERS ===

  get audioNode() {
    return this.#delay;
  }

  get context() {
    return this.#context;
  }

  get now() {
    return this.#context.currentTime;
  }

  get input() {
    return this.#preGain;
  }
  get output() {
    return this.#postGain;
  }

  get connections() {
    return {
      outgoing: Array.from(this.#connections),
      incoming: Array.from(this.#incoming),
    };
  }

  get initialized() {
    return this.#initialized;
  }

  get decayActive() {
    return this.#decayActive;
  }

  get numberOfInputs() {
    return this.input.numberOfInputs;
  }

  get numberOfOutputs() {
    return this.output.numberOfOutputs;
  }

  get workletInfo() {
    return {
      numberOfInputs: this.#delay.numberOfInputs,
      numberOfOutputs: this.#delay.numberOfOutputs,
      channelCount: this.#delay.channelCount,
      channelCountMode: this.#delay.channelCountMode,
    };
  }

  // === CLEANUP ===

  dispose() {
    this.disconnect();
    unregisterNode(this.nodeId);
  }
}
