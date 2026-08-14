import {
  Message,
  MessageBus,
  MessageHandler,
  createMessageBus,
} from '@/events';
import { ROOT_NOTES, SCALE_PATTERNS } from '@/utils/music-theory/constants';
import { Debouncer } from '@/utils/Debouncer';
import { AudioParamController } from './AudioParamController';
import { ValueSnapper } from '../helpers/ValueSnapper';
import { assert } from '@/utils';
import { NodeType } from '@/nodes/LibNode';
import type { NormalizeOptions } from '@/nodes/params/param-types';

export class MacroParam {
  readonly nodeType: string = 'macro';
  readonly nodeId: NodeID;

  #controller: AudioParamController;
  #snapper: ValueSnapper;
  #debouncer: Debouncer;
  #messages: MessageBus<Message>;
  #paramType: string = '';
  #isReady: boolean = false;
  #currentTargetValue: number;

  constructor(context: BaseAudioContext, initialValue: number) {
    this.#controller = new AudioParamController(context, initialValue);
    this.#snapper = new ValueSnapper();
    this.#debouncer = new Debouncer();

    this.#messages = createMessageBus(this.#controller.nodeId);
    this.nodeId = this.#controller.nodeId;
    this.#currentTargetValue = initialValue;

    this.#isReady = true;
  }

  async init(): Promise<void> {
    // No-op for sync classes
  }

  addTarget(
    targetParam: AudioParam,
    paramType: string,
    scaleFactor: number = 1,
  ): this {
    if (!this.#paramType) this.#paramType = paramType;
    assert(
      // todo: allow multiple types
      paramType === this.#paramType,
      'Macros only support a single ParamType',
    );

    this.#controller.addTarget(targetParam, scaleFactor);
    return this;
  }

  ramp(
    targetValue: number,
    duration: number,
    constant: number,
    options: {
      method?: 'exponential' | 'linear';
      debounceMs?: number;
      onComplete?: () => void;
      onCompleteDelayMs?: number;
    } = {},
  ): this {
    const processedValue = this.#processValue(targetValue, constant);
    if (processedValue === this.#currentTargetValue) return this;

    // const direction =
    //   processedValue > this.#currentTargetValue ? 'increment' : 'decrement';
    // console.debug(this.#paramType, direction);

    this.#currentTargetValue = processedValue;

    const {
      method = 'exponential',
      debounceMs = 20,
      onComplete,
      onCompleteDelayMs = 30,
    } = options;

    const executeRamp = () => {
      this.#controller.ramp(processedValue, duration, method, true);

      if (onComplete) {
        setTimeout(onComplete, duration * 1000 + onCompleteDelayMs);
      }
    };

    if (debounceMs === 0) {
      executeRamp();
    } else {
      const debounced = this.#debouncer.debounce(
        executeRamp,
        debounceMs,
        this.nodeId, // explicit key (can be omitted for auto-keying)
      );
      debounced();
    }

    return this;
  }

  debugProcessVal(value: number, constant: number, targetPeriod: number) {
    console.log('MacroParam.#processValue input:', {
      value,
      constant,
      targetPeriod,
      hasValueSnapping: this.#snapper.hasValueSnapping,
      hasPeriodSnapping: this.#snapper.hasPeriodSnapping,
      longestPeriod: this.#snapper.longestPeriod,
    });
  }

  #processValue(targetValue: number, constant: number): number {
    if (!Number.isFinite(targetValue) || !Number.isFinite(constant)) {
      return targetValue;
    }

    const targetPeriod = Math.abs(targetValue - constant);

    if (
      this.#snapper.hasPeriodSnapping &&
      targetPeriod < this.#snapper.longestPeriod
    ) {
      const quantizedPeriod = this.#snapper.snapToMusicalPeriod(targetPeriod);

      let result;

      if (this.#paramType === 'loopEnd') {
        result = constant + quantizedPeriod;
      }

      if (this.#paramType === 'loopStart') {
        // Ensure we don't go beyond bounds when quantizing
        result = Math.max(0, constant - quantizedPeriod);

        // If this would make loopStart too close to loopEnd,
        // use the next smaller quantized period instead
        if (result >= constant - 0.001) {
          // Find the next smaller period
          const periods = this.#snapper.periods;
          const smallerPeriods = periods.filter((p) => p < quantizedPeriod);

          if (smallerPeriods.length > 0) {
            const nextSmaller = Math.max(...smallerPeriods);
            result = constant - nextSmaller;
          } else {
            // If no smaller period exists, maintain minimum distance
            result = Math.max(0, constant - 0.001);
          }
        }
      }

      if (result !== undefined) return result;
    } else if (this.#snapper.hasValueSnapping) {
      const snapped = this.#snapper.snapToValue(targetValue);
      return snapped;
    }

    // this.#debugProcessedValue(
    //   targetValue,
    //   constant,
    //   targetPeriod,
    //   quantizedPeriod,
    //   result ?? -1
    // );

    return targetValue;
  }

  // Delegate configuration methods
  setAllowedParamValues(
    values: number[],
    normalize: NormalizeOptions | false,
  ): number[] {
    return this.#snapper.setAllowedValues(values, normalize);
  }

  setAllowedPeriods(
    periods: number[],
    normalize: NormalizeOptions | false,
    snapToZeroCrossings: number[] | false = false,
  ): number[] {
    return this.#snapper.setAllowedPeriods(
      periods,
      normalize,
      snapToZeroCrossings,
    );
  }

  setScale(options: {
    rootNote: keyof typeof ROOT_NOTES;
    scale: keyof typeof SCALE_PATTERNS | number[];
    tuningOffset: number;
    highestOctave: number;
    lowestOctave: number;
    snapToZeroCrossings: number[] | false;
    normalize: NormalizeOptions | false;
  }): number[] {
    const {
      rootNote,
      scale,
      tuningOffset = 0,
      lowestOctave = 0,
      highestOctave = 8,
    } = options;

    const scalePattern = Array.isArray(scale) ? scale : SCALE_PATTERNS[scale];

    return this.#snapper.setScale(
      rootNote,
      scalePattern,
      tuningOffset,
      lowestOctave,
      highestOctave,
      options.normalize,
      options.snapToZeroCrossings,
    );
  }

  setValue(value: number, timestamp?: number): this {
    this.#controller.setValue(value, timestamp);
    this.#currentTargetValue = value;
    // this.#sendValueChangedMessage(value); // Todo: Uncomment if needed for onChange callback, otherwise delete this line and onChange.
    return this;
  }

  getValue = (): number => this.#controller.value;

  get targetValue(): number {
    return this.#currentTargetValue;
  }

  get targets() {
    return this.#controller.targets;
  }

  get snapper(): ValueSnapper {
    return this.#snapper;
  }

  get rootNote() {
    return this.#snapper.rootNote;
  }

  setRootNote(rootNote: keyof typeof ROOT_NOTES) {
    this.#snapper.setRootNote(rootNote);
  }

  get scalePattern() {
    return this.#snapper.scalePattern;
  }

  get isReady() {
    return this.#isReady;
  }

  get now(): number {
    throw new Error('Not implemented');
  }

  get audioParam(): AudioParam {
    return this.#controller.param;
  }

  get type(): string {
    return this.#paramType;
  }

  get longestPeriod(): number {
    return this.#snapper.longestPeriod;
  }

  onChange(callback: MessageHandler<Message>): () => void {
    return this.onMessage('value:changed', callback);
  }

  #sendValueChangedMessage(value: number): void {
    this.#messages.sendMessage('value:changed', { value });
  }

  // Message bus methods
  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  protected sendMessage(type: string, data: any): void {
    this.#messages.sendMessage(type, data);
  }

  dispose(): void {
    this.#controller.dispose();
    // Clean up other resources
  }

  #debugProcessedValue = (
    targetValue: number,
    constant: number,
    targetPeriod: number,
    quantizedPeriod: number,
    result: number,
  ) => {
    console.debug(
      'adjusting param: ',
      this.#paramType,
      'targetValue',
      targetValue,
      'constant',
      constant,
      'targetPeriod',
      targetPeriod,
      'quantizedPeriod',
      quantizedPeriod,
      'result',
      result,
    );
  };

  // Stub methods for interface compliance
  connect(target: AudioParam, nodeType: NodeType, scaleFactor?: number): this {
    this.addTarget(target, nodeType, scaleFactor);
    return this;
  }

  disconnect(target?: AudioParam | TODO): void {
    throw new Error('Not implemented');
  }
}

// old code, delete:
// #processValue(value: number, constant: number): number {
//   const targetPeriod = Math.abs(value - constant);
//   // this.debugProcessVal(value, constant, targetPeriod)
//   if (
//     this.#snapper.hasPeriodSnapping &&
//     targetPeriod < this.#snapper.longestPeriod
//   ) {
//     const snapped = this.#snapper.snapToPeriod(value, constant);
//     console.log('MacroParam.#processValue period snapped:', {
//       value,
//       snapped,
//     });
//     return snapped;
//   } else if (this.#snapper.hasValueSnapping) {
//     const snapped = this.#snapper.snapToValue(value);
//     return snapped;
//   }

//   return value;
// }
