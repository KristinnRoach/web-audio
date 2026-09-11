// Ceiling the clipped path is normalized to, regardless of clipping threshold.
// Lowering the threshold then adds harmonics instead of dropping level, which is
// what made the macro lose ~7 dB over its last 10% of travel. One knob: lower it
// for more headroom under the bus limiter, raise it for a louder wet path. See #57.
const CLIP_OUTPUT_CEILING = 0.3;

class Distortion {
  constructor() {
    this.limitingMode = "hard-clipping";
  }

  applyDrive(sample, driveAmount) {
    if (driveAmount <= 0) return sample;

    const driveMultiplier = 1 + driveAmount * 3; // 1x to 4x drive
    const drivenSample = sample * driveMultiplier;

    return drivenSample;
  }

  applyClipping(sample, clippingAmount, clipThreshold) {
    if (clippingAmount <= 0) return sample;

    // Both shapers normalize by the threshold first, then scale to the fixed
    // ceiling, so the clipped path holds its level as the threshold drops.
    // clippingThreshold's minValue keeps these divisions away from zero.
    let clippedSample;
    switch (this.limitingMode) {
      case "soft-clipping":
        clippedSample = CLIP_OUTPUT_CEILING * Math.tanh(sample / clipThreshold);
        break;

      case "hard-clipping":
        clippedSample = CLIP_OUTPUT_CEILING * Math.max(-1, Math.min(1, sample / clipThreshold));
        break;

      case "bypass":
      default:
        // Nothing was clipped, so there is no ceiling to normalize against.
        clippedSample = sample;
        break;
    }

    // Blend clean and clipped
    const blended = sample * (1 - clippingAmount) + clippedSample * clippingAmount;

    return blended;
  }

  setLimitingMode(mode) {
    this.limitingMode = mode;
  }
}

registerProcessor(
  "distortion-processor",
  class extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        {
          name: "distortionDrive",
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: "a-rate",
        },
        {
          name: "clippingAmount",
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: "a-rate",
        },
        {
          name: "clippingThreshold",
          defaultValue: 0.5,
          // Non-zero: applyClipping divides by this, and 0 yields NaN, which
          // permanently silences every downstream node.
          minValue: 0.001,
          maxValue: 1,
          automationRate: "k-rate",
        },
      ];
    }

    constructor() {
      super();
      this.distortion = new Distortion();
      this.setupMessageHandling();
      // Signal to node that processor is initialized
      this.port.postMessage({ type: "initialized" });
    }

    setupMessageHandling() {
      this.port.onmessage = (event) => {
        switch (event.data.type) {
          case "setLimitingMode":
            this.distortion.setLimitingMode(event.data.mode);
            break;

          default:
            console.warn("distortion-processor: Unsupported message");
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
          parameters.distortionDrive[Math.min(i, parameters.distortionDrive.length - 1)];
        const clippingAmount =
          parameters.clippingAmount[Math.min(i, parameters.clippingAmount.length - 1)];

        // Process each channel
        for (let c = 0; c < Math.min(input.length, output.length); c++) {
          let sample = input[c][i];

          // Apply distortion drive
          sample = this.distortion.applyDrive(sample, distortionDrive);

          // Apply clipping blend
          sample = this.distortion.applyClipping(sample, clippingAmount, clipThreshold);

          // No output clamp here: Web Audio is float32 and the bus limiter
          // (DynamicsCompressor @ -1 dB) owns output protection. Clamping here
          // made a bypassed stage a hard clipper. See #55.
          output[c][i] = sample;
        }
      }

      return true;
    }
  },
);

export {}; // module marker so the test can import this file
