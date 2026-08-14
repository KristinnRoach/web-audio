class SpectralFreezeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fftSize = 2048;
    this.hopSize = this.fftSize / 2;
    this.window = this.makeHannWindow(this.fftSize);

    this.inputBuffer = new Float32Array(this.fftSize);
    this.inputWritePos = 0;

    this.outputBuffer = new Float32Array(this.fftSize + this.hopSize); // Extra for overlap-add
    this.outputReadPos = 0;

    this.isFrozen = false;
    this.frozenSpectrum = null; // stored frozen complex bins
    this.hasLoggedFFT = false; // To log FFT only once
    this.fftCaptureCount = 0; // Track how many FFTs we've captured
    // Preallocate analysis buffer for windowed frame
    this._frameWindowed = new Float32Array(this.fftSize);

    // Check if FFT library is available
    console.log(
      '[SpectralFreeze] Constructor - fft available:',
      typeof fft !== 'undefined',
    );
    console.log(
      '[SpectralFreeze] Constructor - ifft available:',
      typeof ifft !== 'undefined',
    );

    this.port.onmessage = (event) => {
      if (event.data === 'freeze') {
        this.isFrozen = true;
        this.outputReadPos = this.hopSize; // Force refill on first freeze
        console.log(
          '[SpectralFreeze] Freeze activated, spectrum available:',
          !!this.frozenSpectrum,
        );
      } else if (event.data === 'unfreeze') {
        this.isFrozen = false;
      }
    };
  }

  makeHannWindow(size) {
    let window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
  }

  overlapAdd(output, input, startPos) {
    for (let i = 0; i < input.length; i++) {
      output[i + startPos] = (output[i + startPos] || 0) + input[i];
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Safety check
    if (!input || !output || input.length === 0 || output.length === 0) {
      return true;
    }

    if (!this.isFrozen) {
      // PASSTHROUGH MODE - direct copy, zero latency, NO FFT processing
      for (let ch = 0; ch < Math.min(input.length, output.length); ch++) {
        if (input[ch] && output[ch]) {
          output[ch].set(input[ch]);
        }
      }

      // Store the last frame for potential freezing (simple time-domain)
      if (input[0] && input[0].length > 0) {
        // Just keep the last received block
        const in0 = input[0];
        const copyLength = Math.min(in0.length, this.fftSize);
        let maxVal = 0.0;

        // Copy new data
        this.inputBuffer.set(in0.subarray(0, copyLength));
        // Find maxVal in the new data
        for (let i = 0; i < copyLength; i++) {
          const absV = Math.abs(this.inputBuffer[i]);
          if (absV > maxVal) maxVal = absV;
        }
        // Clear the rest of the buffer to remove stale data
        if (copyLength < this.fftSize) {
          this.inputBuffer.fill(0, copyLength);
        }

        if (maxVal > 0.01) {
          // Reuse a preallocated analysis buffer
          const frameWindowed = this._frameWindowed;
          for (let j = 0; j < this.fftSize; j++) {
            frameWindowed[j] = this.inputBuffer[j] * this.window[j];
          }

          try {
            this.frozenSpectrum = fft(frameWindowed);
            this.fftCaptureCount++;

            // if (this.fftCaptureCount % 10 === 0) {
            //   console.debug(
            //     `[SpectralFreeze] Updated spectrum #${this.fftCaptureCount}, max:`,
            //     maxVal.toFixed(4)
            //   );
            // }
          } catch (error) {
            console.error('[SpectralFreeze] FFT error:', error);
          }
        }
      }
    } else {
      // FROZEN MODE - use FFT-based spectral processing
      const outChannel = output[0];

      if (!this.frozenSpectrum || !outChannel) {
        // No spectrum captured yet, output silence
        for (let ch = 0; ch < output.length; ch++) {
          if (output[ch]) {
            output[ch].fill(0);
          }
        }
        return true;
      }

      for (let i = 0; i < outChannel.length; i++) {
        // Refill output buffer when depleted
        if (this.outputReadPos >= this.hopSize) {
          try {
            // Inverse FFT to reconstruct audio from frozen spectrum
            let reconstructed = ifft(this.frozenSpectrum);

            // Apply window
            for (let k = 0; k < reconstructed.length; k++) {
              reconstructed[k] *= this.window[k];
            }

            // Shift output buffer and overlap-add
            this.outputBuffer.copyWithin(0, this.hopSize);
            this.outputBuffer.fill(0, this.hopSize);

            // Add reconstructed frame
            for (let k = 0; k < reconstructed.length; k++) {
              this.outputBuffer[k] =
                (this.outputBuffer[k] || 0) + reconstructed[k];
            }

            this.outputReadPos = 0;
          } catch (error) {
            console.error('[SpectralFreeze] IFFT error:', error);
          }
        }

        // Output sample from buffer
        outChannel[i] = this.outputBuffer[this.outputReadPos++] || 0;
      }

      // Copy to other channels
      for (let ch = 1; ch < output.length; ch++) {
        if (output[ch]) {
          output[ch].set(outChannel);
        }
      }
    }

    return true;
  }
}

registerProcessor('spectral-freeze-processor', SpectralFreezeProcessor);

// export class SpectralFreezeProcessor extends AudioWorkletProcessor {
//   constructor() {
//     super();
//     this.frozen = false;
//     this.frozenFrame = null;

//     this.port.onmessage = (event) => {
//       if (event.data === 'freeze') this.frozen = true;
//       else if (event.data === 'unfreeze') this.frozen = false;
//     };
//   }

//   process(inputs, outputs) {
//     const input = inputs[0];
//     const output = outputs[0];

//     if (!input || input.length === 0) return true;

//     if (!this.frozen) {
//       // Direct passthrough
//       for (let ch = 0; ch < input.length; ++ch) {
//         output[ch].set(input[ch]);
//       }
//       // Keep the last audio frame in memory
//       this.frozenFrame = input.map((buf) => Float32Array.from(buf));
//     } else if (this.frozenFrame) {
//       // Output the last captured audio frame repeatedly
//       for (let ch = 0; ch < output.length; ++ch) {
//         output[ch].set(this.frozenFrame[ch] || []);
//       }
//     } else {
//       // If freeze requested before audio input, output silence
//       for (let ch = 0; ch < output.length; ++ch) output[ch].fill(0);
//     }
//     return true;
//   }
// }

// registerProcessor('spectral-freeze-processor', SpectralFreezeProcessor);
