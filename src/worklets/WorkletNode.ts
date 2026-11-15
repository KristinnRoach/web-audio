import { WorkletConfig, DefaultWorkletConfig } from './worklet-types';

export class WorkletNode<
  TConfig extends WorkletConfig = DefaultWorkletConfig,
> extends AudioWorkletNode {
  constructor(
    audioContext: BaseAudioContext,
    processorName: string,
    options?: AudioWorkletNodeOptions,
  ) {
    super(audioContext, processorName, options);
    this.port.onmessage = (event: MessageEvent<any>) => {
      // Allow user to listen for other messages
      if (this._onProcessorMessage) {
        this._onProcessorMessage(event);
      }
    };
  }

  /**
   * Glides to `value` with `setTargetAtTime` to avoid clicks.
   * Pass `timeConstant = 0` for discrete params to set the value instantly.
   */
  setParam<K extends keyof TConfig['params']>(
    name: K,
    value: TConfig['params'][K],
    timeConstant = 0.005,
  ): this {
    const param = this.parameters.get(name as string);
    if (!param) {
      console.warn(`Parameter '${String(name)}' not found on worklet node`);
      return this;
    }
    const now = this.context.currentTime;
    // Assumes no other automation on this param. If getParam() callers schedule
    // ramps, call cancelAndPinParamValue(param, now) from '@/nodes/params/audioparam-utils' first.
    if (timeConstant > 0) param.setTargetAtTime(value, now, timeConstant);
    else param.setValueAtTime(value, now);
    return this;
  }

  getParam<K extends keyof TConfig['params']>(name: K): AudioParam | undefined {
    return this.parameters.get(name as string);
  }

  // Message passing
  sendProcessorMessage(message: TConfig['message']): this {
    // MessagePort queues until the processor listens; no main-thread round trip is needed.
    this.port.postMessage(message);
    return this;
  }

  private _onProcessorMessage?: (event: MessageEvent<TConfig['message']>) => void;

  onProcessorMessage(callback: (event: MessageEvent<TConfig['message']>) => void): this {
    this._onProcessorMessage = callback;
    return this;
  }

  dispose(): void {
    this.disconnect();
    this.port.onmessage = null;
    this.port.close();
  }
}
