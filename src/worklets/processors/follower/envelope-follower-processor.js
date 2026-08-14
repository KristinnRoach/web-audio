// envelope-follower-processor.js
registerProcessor(
  'envelope-follower-processor',
  class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        {
          name: 'inputGain', // linear gain (1.0 = unity)
          defaultValue: 1,
          minValue: 0,
          maxValue: 10,
          automationRate: 'k-rate',
        },
        {
          name: 'outputGain', // linear gain (1.0 = unity)
          defaultValue: 1.0,
          minValue: 0.0,
          maxValue: 10.0,
          automationRate: 'k-rate',
        },
        {
          name: 'attack', // seconds
          defaultValue: 0.003,
          minValue: 0.001,
          maxValue: 1.0,
          automationRate: 'k-rate',
        },
        {
          name: 'release', // seconds
          defaultValue: 0.05,
          minValue: 0.001,
          maxValue: 5.0,
          automationRate: 'k-rate',
        },
      ];
    }

    constructor() {
      super();
      this.envelope = 0;
      this.gateThreshold = 0.005;
      this.debugCounter = 0;
      // Signal to node that processor is initialized
      this.port.postMessage({ type: 'initialized' });
    }

    process(inputs, outputs, parameters) {
      const input = inputs[0];
      const output = outputs[0];
      const channel = inputs[0][0];

      if (
        !input ||
        !output ||
        !channel ||
        input.length === 0 ||
        output.length === 0 ||
        channel.length === 0
      ) {
        return true;
      }

      const inChannel = input[0];
      if (!inChannel || inChannel.length === 0) return true;

      const attack = parameters.attack[0];
      const release = parameters.release[0];
      const inputGain = parameters.inputGain[0];
      const outputGain = parameters.outputGain[0];

      // Convert time constants to filter coefficients
      const attackCoeff = Math.exp(-1 / (attack * sampleRate));
      const releaseCoeff = Math.exp(-1 / (release * sampleRate));

      for (let sample = 0; sample < output[0].length; sample++) {
        // Get absolute value of input (rectify)
        const inputLevel = Math.abs((input[0][sample] || 0) * inputGain);

        // if (this.debugCounter++ % 4800 === 0) {
        //   console.log(
        //     `Input: ${inputLevel.toFixed(6)}, Envelope: ${this.envelope.toFixed(6)}`
        //   );
        // }

        // Check if we have actual input signal
        if (inputLevel > 1e-6) {
          // Normal envelope follower when we have signal
          if (inputLevel > this.envelope) {
            this.envelope =
              inputLevel + (this.envelope - inputLevel) * attackCoeff;
          } else {
            this.envelope =
              inputLevel + (this.envelope - inputLevel) * releaseCoeff;
          }
        } else {
          // When input is silent, just decay the envelope
          this.envelope *= releaseCoeff;
        }

        // Clamp very small values to zero
        if (this.envelope < this.gateThreshold) this.envelope = 0;

        // Apply output gain and send to all channels
        const finalOutput = this.envelope * outputGain;

        for (let channel = 0; channel < output.length; channel++) {
          output[channel][sample] = finalOutput;
        }
      }

      return true;
    }
  }
);
