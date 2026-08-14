class Distortion {
  constructor() {
    this.limitingMode = 'hard-clipping';
  }

  applyDrive(sample, driveAmount) {
    if (driveAmount <= 0) return sample;

    const driveMultiplier = 1 + driveAmount * 3; // 1x to 4x drive
    const drivenSample = sample * driveMultiplier;

    return drivenSample;
  }

  applyClipping(sample, clippingAmount, clipThreshold) {
    if (clippingAmount <= 0) return sample;

    let clippedSample;
    switch (this.limitingMode) {
      case 'soft-clipping':
        clippedSample = clipThreshold * Math.tanh(sample / clipThreshold);
        break;

      case 'hard-clipping':
        clippedSample = Math.max(
          -clipThreshold,
          Math.min(clipThreshold, sample)
        );
        break;

      case 'bypass':
      default:
        clippedSample = sample;
        break;
    }

    // Add makeup gain to compensate for extreme low clip threshold
    if (clipThreshold < 0.08) {
      const makeupGain = Math.min(2, Math.pow(0.1 / clipThreshold, 0.5));
      clippedSample *= makeupGain;
    }

    // Blend clean and clipped
    const blended =
      sample * (1 - clippingAmount) + clippedSample * clippingAmount;

    return blended;
  }

  setLimitingMode(mode) {
    this.limitingMode = mode;
  }
}

registerProcessor(
  'distortion-processor',
  class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        {
          name: 'distortionDrive',
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: 'a-rate',
        },
        {
          name: 'clippingAmount',
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: 'a-rate',
        },
        {
          name: 'clippingThreshold',
          defaultValue: 0.5,
          minValue: 0,
          maxValue: 1,
          automationRate: 'k-rate',
        },
      ];
    }

    constructor() {
      super();
      this.distortion = new Distortion();
      this.setupMessageHandling();
      // Signal to node that processor is initialized
      this.port.postMessage({ type: 'initialized' });
    }

    setupMessageHandling() {
      this.port.onmessage = (event) => {
        switch (event.data.type) {
          case 'setLimitingMode':
            this.distortion.setLimitingMode(event.data.mode);
            break;

          default:
            console.warn('distortion-processor: Unsupported message');
            break;
        }
      };
    }

    process(inputs, outputs, parameters) {
      const input = inputs[0];
      const output = outputs[0];

      if (!input || !output) return true;

      const clipThreshold = parameters.clippingThreshold[0];

      // Process each sample
      for (let i = 0; i < output[0].length; ++i) {
        const distortionDrive =
          parameters.distortionDrive[
            Math.min(i, parameters.distortionDrive.length - 1)
          ];
        const clippingAmount =
          parameters.clippingAmount[
            Math.min(i, parameters.clippingAmount.length - 1)
          ];

        // Process each channel
        for (let c = 0; c < Math.min(input.length, output.length); c++) {
          let sample = input[c][i];

          // Apply distortion drive
          sample = this.distortion.applyDrive(sample, distortionDrive);

          // Apply clipping blend
          sample = this.distortion.applyClipping(
            sample,
            clippingAmount,
            clipThreshold
          );

          // Basic output limiting
          output[c][i] = Math.max(-0.999, Math.min(0.999, sample));
        }
      }

      return true;
    }
  }
);
