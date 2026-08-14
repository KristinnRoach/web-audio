class RandomNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.previousNoise = 0;
    this.previousFiltered = 0;
    this.hpfHz = 150; // Default // Test for optimal values
    this.alpha = this.hpfHz / (this.hpfHz + sampleRate / (2 * Math.PI));

    this.port.onmessage = (event) => {
      if (event.data.type === 'setHpfHz') {
        this.hpfHz = event.data.value;
        this.alpha = this.calculateAlpha(this.hpfHz);
      }
    };
    // Signal to node that processor is initialized
    this.port.postMessage({ type: 'initialized' });
  }

  calculateAlpha(frequency) {
    return frequency / (frequency + sampleRate / (2 * Math.PI));
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    output.forEach((channel) => {
      for (let i = 0; i < channel.length; i++) {
        const noise = Math.random() * 2 - 1;
        const filtered =
          this.alpha * (noise - this.previousNoise) + this.previousFiltered;
        this.previousNoise = noise;
        this.previousFiltered = filtered;
        channel[i] = filtered;
      }
    });
    return true;
  }
}

registerProcessor('random-noise-processor', RandomNoiseProcessor);

// class RandomNoiseProcessor extends AudioWorkletProcessor {
//   process(inputs, outputs, parameters) {
//     const output = outputs[0];
//     output.forEach((channel) => {
//       for (let i = 0; i < channel.length; i++) {
//         channel[i] = Math.random() * 2 - 1;
//       }
//     });
//     return true;
//   }
// }

// registerProcessor('random-noise-processor', RandomNoiseProcessor);
