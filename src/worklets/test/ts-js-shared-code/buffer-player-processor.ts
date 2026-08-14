// buffer-player-processor.ts - Simple audio buffer playback processor
import { AudioProcessorMessage } from './types';

class BufferPlayerProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array[] | null = null;
  private isPlaying = false;
  private playbackPosition = 0;
  private gain = 1.0;
  private bufferSampleRate = 44100; // Default assumption
  private playbackRatio = 1.5; // Ratio for sample rate conversion

  constructor() {
    super();
    // Set up message handling from main thread
    this.port.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(event: MessageEvent<AudioProcessorMessage>) {
    const { type, payload } = event.data;

    switch (type) {
      case 'loadBuffer':
        // Buffer comes as array of channels
        this.buffer = payload.buffer as Float32Array<ArrayBufferLike>[];
        this.playbackPosition = 0;

        // Store the original sample rate and calculate playback ratio
        if (payload.sampleRate) {
          this.bufferSampleRate = payload.sampleRate;
          // Calculate ratio between original sample rate and AudioContext sample rate
          this.playbackRatio = this.bufferSampleRate / sampleRate;
          console.log(
            `Buffer sample rate: ${this.bufferSampleRate}, AudioContext sample rate: ${sampleRate}, Ratio: ${this.playbackRatio}`
          );
        }

        if (this.buffer && this.buffer[0]) {
          this.port.postMessage({
            type: 'bufferLoaded',
            payload: {
              numChannels: this.buffer.length,
              length: this.buffer[0].length || 0,
            },
          });
        }
        break;

      case 'play':
        this.isPlaying = true;
        this.playbackPosition = payload?.position || 0;
        break;

      case 'stop':
        this.isPlaying = false;
        this.playbackPosition = 0;
        break;

      case 'pause':
        this.isPlaying = false;
        break;

      case 'setVolume':
        this.gain = payload;
        break;
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    // If no buffer or not playing, output silence and keep alive
    if (!this.buffer || !this.isPlaying) {
      // Fill output with silence
      const output = outputs[0];
      for (let channel = 0; channel < output.length; channel++) {
        const outputChannel = output[channel];
        for (let i = 0; i < outputChannel.length; i++) {
          outputChannel[i] = 0;
        }
      }
      return true;
    }

    // Get output and determine number of channels to process
    const output = outputs[0];
    const channelsToProcess = Math.min(this.buffer.length, output.length);

    // Process each channel
    for (let channel = 0; channel < channelsToProcess; channel++) {
      const outputChannel = output[channel];
      const bufferChannel = this.buffer[channel];

      // Fill the output with buffer data
      for (let i = 0; i < outputChannel.length; i++) {
        // Calculate the exact position in the source buffer
        // We need to account for both the current position and the current sample within this block
        const exactPosition = this.playbackPosition + i * this.playbackRatio;
        const position = Math.floor(exactPosition);

        if (position < bufferChannel.length) {
          // Copy buffer data to output with gain applied
          outputChannel[i] = bufferChannel[position] * this.gain;
        } else {
          // End of buffer reached
          outputChannel[i] = 0;

          // Check if we've reached the end of the buffer (only do this once per block)
          if (i === 0 && channel === 0) {
            // Reset position and notify main thread
            this.playbackPosition = 0;
            this.isPlaying = false;
            this.port.postMessage({ type: 'playbackEnded' });
          }
        }
      }
    }

    // Advance the playback position once per sample period, NOT once per channel
    if (this.isPlaying) {
      // Advance to the start of the next block
      this.playbackPosition += output[0].length * this.playbackRatio;
    }

    return true; // Keep processor alive
  }
}

// Register the processor
registerProcessor('buffer-player', BufferPlayerProcessor);
