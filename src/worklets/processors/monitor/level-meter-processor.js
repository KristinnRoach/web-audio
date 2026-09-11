// level-meter-processor.js
// Sink node (no outputs). Measures every sample of its input, so unlike a polled
// AnalyserNode it cannot miss a transient between reads.

registerProcessor(
  "level-meter-processor",
  class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const { reportIntervalMs = 100, clipThreshold = 1 } = options?.processorOptions ?? {};
      this.reportInterval = (reportIntervalMs / 1000) * sampleRate;
      this.clipThreshold = clipThreshold;
      this.clipCount = 0;
      this.resetWindow();
    }

    resetWindow() {
      this.peak = 0;
      this.sumSquares = 0;
      this.samples = 0;
    }

    process(inputs) {
      const channels = inputs[0];
      if (!channels || channels.length === 0) return true;

      for (const channel of channels) {
        for (let i = 0; i < channel.length; i++) {
          const sample = channel[i];
          const abs = Math.abs(sample);
          if (abs > this.peak) this.peak = abs;
          if (abs > this.clipThreshold) this.clipCount++;
          this.sumSquares += sample * sample;
        }
        this.samples += channel.length;
      }

      if (this.samples >= this.reportInterval) {
        this.port.postMessage({
          peak: this.peak,
          rms: Math.sqrt(this.sumSquares / this.samples),
          clipCount: this.clipCount,
        });
        this.resetWindow();
      }
      return true;
    }
  },
);

export {}; // module marker so the test can import this file
