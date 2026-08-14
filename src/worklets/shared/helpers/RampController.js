/**
 * RampController manages smooth value transitions over time using linear or exponential ramping.
 * Useful for audio parameter automation in Web Audio API contexts.
 */
class RampController {
  static #epsilon = 1e-10;

  #isRamping = false;
  #rampMethod = 'linear';
  #sampleRate = 48000;
  #currVal = 0;
  #targetVal = 0;
  #rampSamples = 0;
  #currSample = 0;
  #increment = 0;
  #multiplier = 1;

  constructor(sampleRate = 48000) {
    this.#sampleRate = sampleRate;
  }

  linearRamp(targetValue, rampTimeSeconds) {
    if (rampTimeSeconds < RampController.#epsilon) {
      this.setValue(targetValue);
      return;
    }

    this.#rampMethod = 'linear';
    this.#isRamping = true;

    this.#targetVal = targetValue;
    this.#rampSamples = Math.floor(rampTimeSeconds * this.#sampleRate);
    this.#currSample = 0;
    this.#increment = (targetValue - this.#currVal) / this.#rampSamples;
  }

  exponentialRamp(targetValue, rampTimeSeconds) {
    if (rampTimeSeconds < RampController.#epsilon) {
      this.setValue(targetValue);
      return;
    }

    this.#rampMethod = 'exponential';
    this.#isRamping = true;

    if (Math.abs(this.#currVal) < RampController.#epsilon) {
      this.linearRamp(targetValue, rampTimeSeconds);
      return; // fallback
    }

    this.#targetVal = targetValue;
    this.#rampSamples = Math.floor(rampTimeSeconds * this.#sampleRate);
    this.#currSample = 0;
    this.#multiplier = Math.pow(
      targetValue / this.#currVal,
      1 / this.#rampSamples
    );
  }

  getNextValue() {
    if (!this.#isRamping) return this.#currVal;

    if (this.#currSample < this.#rampSamples) {
      switch (this.#rampMethod) {
        case 'linear':
          this.#currVal += this.#increment;
          break;
        case 'exponential':
          this.#currVal *= this.#multiplier;
          break;
      }
      this.#currSample++;
    } else {
      this.#currVal = this.#targetVal;
      this.#isRamping = false;
    }

    return this.#currVal;
  }

  setValue(value) {
    this.#currVal = value;
    this.#targetVal = value;
    this.#isRamping = false;
  }

  setSampleRate(rate) {
    this.#sampleRate = rate;
  }

  get value() {
    return this.#currVal;
  }

  get sampleRate() {
    return this.#sampleRate;
  }

  get isRamping() {
    return this.#isRamping;
  }
}
