import { WorkletConfig, DefaultWorkletConfig } from './worklet-types';

export class WorkletNode<
  TConfig extends WorkletConfig = DefaultWorkletConfig,
> extends AudioWorkletNode {
  private _processorReady = false;
  private _messageQueue: TConfig['message'][] = [];

  constructor(
    audioContext: AudioContext,
    processorName: string,
    options?: AudioWorkletNodeOptions
  ) {
    super(audioContext, processorName, options);
    // Listen for processor handshake
    this.port.onmessage = (event: MessageEvent<any>) => {
      if (event.data && event.data.type === 'initialized') {
        this._processorReady = true;
        // Flush queued messages
        for (const msg of this._messageQueue) {
          this.port.postMessage(msg);
        }
        this._messageQueue = [];
      }
      // Allow user to listen for other messages
      if (this._onProcessorMessage) {
        this._onProcessorMessage(event);
      }
    };
  }

  setParam<K extends keyof TConfig['params']>(
    name: K,
    value: TConfig['params'][K]
  ): this {
    const param = this.parameters.get(name as string);
    if (!param) {
      console.warn(`Parameter '${String(name)}' not found on worklet node`);
      return this;
    }
    param.setValueAtTime(value, this.context.currentTime);
    return this;
  }

  getParam<K extends keyof TConfig['params']>(name: K): AudioParam | undefined {
    return this.parameters.get(name as string);
  }

  // Message passing
  sendProcessorMessage(message: TConfig['message']): this {
    if (this._processorReady) {
      this.port.postMessage(message);
    } else {
      this._messageQueue.push(message);
    }
    return this;
  }

  private _onProcessorMessage?: (
    event: MessageEvent<TConfig['message']>
  ) => void;

  onProcessorMessage(
    callback: (event: MessageEvent<TConfig['message']>) => void
  ): this {
    this._onProcessorMessage = callback;
    return this;
  }

  dispose(): void {
    this.disconnect();
    this.port.onmessage = null;
    this.port.close();
  }
}
