// FeedbackDelay.js

import { compressSingleSample } from '../../shared/utils/compress-utils';
import { DelayBuffer } from './DelayBuffer';

const AUTO_GAIN_THRESHOLD = 0.8;
const SAFETY_GAIN_COMPENSATION = 0.2;
export class FeedbackDelay {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.buffers = [];
    this.initialized = false;
    this.autoGainEnabled = false;
    this.gainCompensation = SAFETY_GAIN_COMPENSATION;

    this.lowpassStates = [];
    this.highpassStates = [];
    this.highpassInputStates = [];
  }

  initializeBuffers(channelCount) {
    this.buffers = [];
    this.lowpassStates = [];
    this.highpassStates = [];
    this.highpassInputStates = [];

    const maxSamples = Math.floor(this.sampleRate * 2); // Max 2 second delay

    for (let c = 0; c < channelCount; c++) {
      this.buffers[c] = new DelayBuffer(maxSamples);
      this.lowpassStates[c] = 0;
      this.highpassStates[c] = 0;
      this.highpassInputStates[c] = 0;
    }
    this.initialized = true;
  }

  /** Simple one-pole lowpass filter */
  lowpass(input, cutoffFreq, channelIndex) {
    // Skip filtering if cutoff is too high (avoids instability)
    if (cutoffFreq >= this.sampleRate * 0.4) {
      return input;
    }

    const omega = (2 * Math.PI * cutoffFreq) / this.sampleRate;
    const alpha = Math.max(
      0,
      Math.min(0.99, Math.sin(omega) / (Math.sin(omega) + Math.cos(omega)))
    );

    this.lowpassStates[channelIndex] =
      alpha * input + (1 - alpha) * this.lowpassStates[channelIndex];

    return this.lowpassStates[channelIndex];
  }

  /** Simple one-pole highpass filter */
  highpass(input, cutoffFreq, channelIndex) {
    if (cutoffFreq < 5) return input;

    const omega = (2 * Math.PI * cutoffFreq) / this.sampleRate;
    const alpha = Math.max(
      0,
      Math.min(0.99, Math.sin(omega) / (Math.sin(omega) + Math.cos(omega)))
    );

    // Highpass = input - lowpass
    // This is more stable than the direct implementation
    const lowpassOutput =
      alpha * input + (1 - alpha) * this.highpassStates[channelIndex];
    const highpassOutput = input - lowpassOutput;

    // Update state (this is actually the lowpass state)
    this.highpassStates[channelIndex] = lowpassOutput;

    return highpassOutput;
  }

  process(
    inputSample,
    channelIndex,
    feedbackAmount,
    delayTime,
    lowpassFreq = 10000,
    highpassFreq = 100
  ) {
    if (!this.initialized) return inputSample;

    const buffer = this.buffers[channelIndex] || this.buffers[0];
    const delaySamples = Math.floor(this.sampleRate * delayTime);
    const delayedSample = buffer.read();

    let filteredDelay = this.highpass(
      delayedSample,
      highpassFreq,
      channelIndex
    );
    filteredDelay = this.lowpass(filteredDelay, lowpassFreq, channelIndex);

    const feedbackSample = feedbackAmount * filteredDelay + inputSample;

    let outputSample = feedbackSample;

    const compressedFeedback = compressSingleSample(feedbackSample, 0.5, 4.0, {
      enabled: true, // limiter enabled
      outputRange: { min: -0.99, max: 0.99 },
      type: 'soft', // soft clip
    });

    if (this.autoGainEnabled && feedbackAmount > AUTO_GAIN_THRESHOLD) {
      const safetyReduction =
        1 - (feedbackAmount - AUTO_GAIN_THRESHOLD) * this.gainCompensation;
      outputSample = compressedFeedback * safetyReduction;
    }

    return { outputSample, feedbackSample: compressedFeedback, delaySamples };
  }

  updateBuffer(channelIndex, sample, delaySamples) {
    const buffer = this.buffers[channelIndex] || this.buffers[0];
    buffer.write(sample);
    buffer.updatePointers(delaySamples);
  }

  setAutoGain(enabled, compensation = SAFETY_GAIN_COMPENSATION) {
    this.autoGainEnabled = enabled;
    this.gainCompensation = compensation;
  }
}

// lowpass(input, cutoffFreq, channelIndex) {
//   // Convert cutoff frequency to filter coefficient
//   const rc = 1.0 / (cutoffFreq * 2 * Math.PI);
//   const dt = 1.0 / this.sampleRate;
//   const alpha = dt / (rc + dt);

//   // Apply filter: output = alpha * input + (1 - alpha) * previousOutput
//   this.filterStates[channelIndex] =
//     alpha * input + (1 - alpha) * this.filterStates[channelIndex];

//   return this.filterStates[channelIndex];
// }
