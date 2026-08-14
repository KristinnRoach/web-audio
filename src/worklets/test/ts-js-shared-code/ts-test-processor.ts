// test-processor.ts - Simple sine wave oscillator processor
import { midiToFreq, softClip, generateSineWave, advancePhase } from './utils';
import { AudioProcessorMessage } from './types';

class TestOscillatorProcessor extends AudioWorkletProcessor {
  // Default values
  private frequency = 440; // A4 in Hz
  private amplitude = 0; // 0-1 range
  private phase = 0;
  private midiNote = 69; // A4
  private distortionAmount = 0;

  constructor() {
    super();
    // Set up message handling from main thread
    this.port.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(event: MessageEvent<AudioProcessorMessage>) {
    const { type, payload } = event.data;

    switch (type) {
      case 'setNote':
        this.midiNote = payload;
        this.frequency = midiToFreq(this.midiNote);
        break;
      case 'setVolume':
        this.amplitude = payload;
        break;
      case 'setDistortion':
        this.distortionAmount = payload;
        break;
    }

    // Send confirmation back to main thread
    this.port.postMessage({
      type: 'paramChanged',
      payload: { param: type, value: payload },
    });
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    // Get output channel data
    const output = outputs[0];
    // sampleRate is a global in AudioWorkletProcessor context

    // Calculate samples for all channels
    for (let channel = 0; channel < output.length; channel++) {
      const outputChannel = output[channel];

      // Generate samples
      for (let i = 0; i < outputChannel.length; i++) {
        // Use the external sine wave generator function
        const sample = generateSineWave(this.phase, this.amplitude);

        // Apply soft clipping effect from our utility
        outputChannel[i] = softClip(sample, this.distortionAmount);

        // Advance phase using the utility function
        this.phase = advancePhase(this.phase, this.frequency, sampleRate);
      }
    }

    return true; // Keep processor alive
  }
}

// Register the processor
registerProcessor('test-oscillator', TestOscillatorProcessor);
