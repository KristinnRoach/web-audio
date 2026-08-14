export class DelayBuffer {
  constructor(maxDelaySamples) {
    this.buffer = new Float32Array(maxDelaySamples);
    this.writePtr = 0;
    this.readPtr = 0;
  }

  write(sample) {
    this.buffer[this.writePtr] = sample;
  }

  read() {
    return this.buffer[this.readPtr];
  }

  updatePointers(delaySamples) {
    this.writePtr = (this.writePtr + 1) % this.buffer.length;
    this.readPtr =
      (this.writePtr - delaySamples + this.buffer.length) % this.buffer.length;
  }
}
