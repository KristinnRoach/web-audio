// Minimal processor for the browser test: the main thread fetches the .wasm and
// passes its bytes in processorOptions; the constructor compiles them.

import { instantiateEnvelopeWasm, WasmBreakpointEnvelope } from './wasm-envelope.js';

class WasmEnvelopeProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: { wasmBytes, shape } }) {
    super();
    this.envelope = new WasmBreakpointEnvelope(instantiateEnvelopeWasm(wasmBytes), sampleRate);
    this.envelope.shape = shape;
    this.envelope.trigger();
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    channel.set(this.envelope.render(channel.length).subarray(0, channel.length));
    return true;
  }
}

registerProcessor('wasm-envelope-processor', WasmEnvelopeProcessor);
