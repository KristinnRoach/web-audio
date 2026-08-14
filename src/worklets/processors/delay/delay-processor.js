// delay-processor.js

import { DelayBuffer } from './DelayBuffer';
import { compressSingleSample } from '../../shared/utils/compress-utils';

const DEFAULT_DELAY_CONFIG = {
  CHARACTER: ['filtered'], // 'clean' | 'bitCrushed' | 'filtered' or combo

  // Smoothing factor for delay time interpolation
  SMOOTHING_FACTOR: {
    slowest: 0.0001, // smoothest pitch changes
    slow: 0.00025,
    medium: 0.00035,
    fast: 0.0005,
    veryFast: 0.001,
    superFast: 0.1,
    none: 1.0, // no smoothing
  },
};

const DEFAULT_CHARACTER_CONFIG = {
  bitCrushed: {
    bits: 11, // bits for bit reduction (e.g. 4 = 16 levels)
    downsample: 3, // downsample factor (1 = no downsampling, 4 = 1/4 samplerate)
  },
  filtered: {
    freq: 900, // Hz
    Q: 0.15, // very subtle / broad
  },
};

registerProcessor(
  'delay-processor',
  class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        {
          name: 'delayTime',
          defaultValue: 0.5,
          minValue: 0.001,
          maxValue: 2,
          automationRate: 'k-rate',
        },
        {
          name: 'feedbackAmount',
          defaultValue: 0.0,
          minValue: 0,
          maxValue: 0.99,
          automationRate: 'k-rate',
        },
      ];
    }

    constructor() {
      super();
      this.buffers = [];
      this.smoothedDelaySamples = [];
      this.smoothingFactor = DEFAULT_DELAY_CONFIG.SMOOTHING_FACTOR.slowest;

      this.characterModes = [...DEFAULT_DELAY_CONFIG.CHARACTER];

      // filtered mode config/state
      this._bpState = [];
      this._bpFreq = DEFAULT_CHARACTER_CONFIG.filtered.freq;
      this._bpQ = DEFAULT_CHARACTER_CONFIG.filtered.Q;
      this._bpCoeffs = null; // Cache for bandpass filter coefficients
      this._lastBpFreq = -1; // Track when coefficients need updating
      this._lastBpQ = -1;

      // lofi mode settings
      this.lofiBits = DEFAULT_CHARACTER_CONFIG['bitCrushed'].bits;
      this.lofiDownsample = DEFAULT_CHARACTER_CONFIG['bitCrushed'].downsample;
      this._lofiSampleHold = [];
      this._lofiSampleCount = [];

      this.initialized = false;

      this.port.onmessage = (event) => {
        if (
          event.data &&
          event.data.type === 'setCharacter' &&
          Array.isArray(event.data.modes)
        ) {
          this.characterModes = [...event.data.modes];
        }
        if (
          event.data &&
          event.data.type === 'setBandpassFreq' &&
          typeof event.data.hz === 'number'
        ) {
          this.setBandpassFreq(event.data.hz);
        }
        if (event.data && event.data.type === 'trigger') {
          // Placeholder for any trigger-related functionality
        }
      };
      // Signal to node that processor is initialized
      this.port.postMessage({ type: 'initialized' });
    }

    setBandpassFreq(hz) {
      this._bpFreq = hz;
      // Invalidate cached coefficients when frequency changes
      this._lastBpFreq = -1;
    }

    _updateBandpassCoeffs() {
      // Only recompute coefficients if parameters have changed
      if (this._lastBpFreq === this._bpFreq && this._lastBpQ === this._bpQ) {
        return;
      }

      const bpFreq = this._bpFreq;
      const bpQ = this._bpQ;

      const omega = (2 * Math.PI * bpFreq) / sampleRate;
      const alpha = Math.sin(omega) / (2 * bpQ);
      const cosw = Math.cos(omega);
      const b0 = alpha;
      const b1 = 0;
      const b2 = -alpha;
      const a0 = 1 + alpha;
      const a1 = -2 * cosw;
      const a2 = 1 - alpha;

      // Normalize coefficients and cache them
      this._bpCoeffs = {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
      };

      this._lastBpFreq = bpFreq;
      this._lastBpQ = bpQ;
    }

    initializeBuffers(channelCount) {
      const maxSamples = Math.floor(sampleRate * 2);
      this.buffers = [];
      this.smoothedDelaySamples = [];
      this._lofiSampleHold = [];
      this._lofiSampleCount = [];
      for (let c = 0; c < channelCount; c++) {
        this.buffers[c] = new DelayBuffer(maxSamples);
        this.smoothedDelaySamples[c] = Math.floor(sampleRate * 0.5); // default 0.5s
        this._lofiSampleHold[c] = 0;
        this._lofiSampleCount[c] = 0;
      }
      this.initialized = true;
    }

    _processLoFi(delayed, c) {
      // Downsampling: only update every N samples
      if (this._lofiSampleCount[c] % this.lofiDownsample === 0) {
        // Bit reduction: quantize to N bits
        const levels = Math.pow(2, this.lofiBits);
        delayed = Math.round(delayed * levels) / levels;
        this._lofiSampleHold[c] = delayed;
      } else {
        delayed = this._lofiSampleHold[c];
      }
      this._lofiSampleCount[c]++;
      return delayed;
    }

    _processBandpass(delayed, c) {
      if (!this._bpState) this._bpState = [];
      if (!this._bpState[c]) {
        this._bpState[c] = { x1: 0, x2: 0, y1: 0, y2: 0 };
      }

      // Update coefficients only if needed (much more efficient)
      this._updateBandpassCoeffs();

      if (!this._bpCoeffs) {
        return delayed; // Fallback if coefficients aren't ready
      }

      const { b0, b1, b2, a1, a2 } = this._bpCoeffs;

      // Apply filter using cached coefficients
      const s = this._bpState[c];
      const y = b0 * delayed + b1 * s.x1 + b2 * s.x2 - a1 * s.y1 - a2 * s.y2;

      // Shift states
      s.x2 = s.x1;
      s.x1 = delayed;
      s.y2 = s.y1;
      s.y1 = y;
      return y;
    }

    process(inputs, outputs, parameters) {
      const input = inputs[0];
      const output = outputs[0];

      // Improved validation: check for proper channel structure
      if (!input || !output || input.length === 0 || output.length === 0) {
        return true;
      }

      // Validate that channels have actual sample data
      if (
        !input[0] ||
        !output[0] ||
        input[0].length === 0 ||
        output[0].length === 0
      ) {
        return true;
      }

      if (!this.initialized || this.buffers.length !== input.length) {
        this.initializeBuffers(input.length);
      }

      const delayTime = parameters.delayTime[0];
      const feedbackAmount = parameters.feedbackAmount[0];
      const targetDelaySamples = sampleRate * delayTime;

      const channelCount = Math.min(input.length, output.length);
      const frameCount = output[0].length;

      const smoothing = this.smoothingFactor;

      for (let i = 0; i < frameCount; ++i) {
        for (let c = 0; c < channelCount; c++) {
          const buf = this.buffers[c];

          // Additional safety check for buffer availability
          if (!buf) {
            continue;
          }

          // Smoothly interpolate delay samples
          this.smoothedDelaySamples[c] +=
            (targetDelaySamples - this.smoothedDelaySamples[c]) * smoothing;
          const smoothedDelay = this.smoothedDelaySamples[c];

          // Fractional delay: linear interpolation between two samples
          const intDelay = Math.floor(smoothedDelay);
          const frac = smoothedDelay - intDelay;
          // Calculate read positions
          const readPtrA =
            (buf.writePtr - intDelay + buf.buffer.length) % buf.buffer.length;
          const readPtrB =
            (readPtrA - 1 + buf.buffer.length) % buf.buffer.length;
          const sampleA = buf.buffer[readPtrA];
          const sampleB = buf.buffer[readPtrB];
          let delayed = sampleA * (1 - frac) + sampleB * frac;

          // Character mode processing (can combine modes, order matters)
          for (const mode of this.characterModes) {
            if (mode === 'bitCrushed') {
              delayed = this._processLoFi(delayed, c);
            } else if (mode === 'filtered') {
              delayed = this._processBandpass(delayed, c);
            }
            // other modes can be added here
          }

          // Apply soft limiting to output
          output[c][i] = compressSingleSample(delayed, 0.75, 4.0, {
            enabled: true,
            type: 'soft',
            outputRange: { min: -0.9, max: 0.9 },
          });
          const inputSample =
            input[c] && input[c][i] !== undefined ? input[c][i] : 0;
          buf.write(inputSample + delayed * feedbackAmount);
          buf.updatePointers(intDelay); // Use integer part for pointer update
        }
      }
      return true;
    }
  }
);
