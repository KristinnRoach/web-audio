import { expect, test, vi } from 'vite-plus/test';
import { TrackedParam } from '../tracked-param';

test('holding a live ramp survives a render quantum between control commands', async () => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  const recorderCode = `registerProcessor('hold-recorder', class extends AudioWorkletProcessor {
    constructor() { super(); this.data = new Float32Array(24000); this.used = 0; }
    process(inputs) {
      const samples = inputs[0]?.[0];
      if (!samples) return true;
      const count = Math.min(samples.length, this.data.length - this.used);
      this.data.set(samples.subarray(0, count), this.used); this.used += count;
      if (this.used === this.data.length) {
        this.port.postMessage(this.data, [this.data.buffer]); return false;
      }
      return true;
    }
  });`;
  const url = URL.createObjectURL(new Blob([recorderCode], { type: 'application/javascript' }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const source = new ConstantSourceNode(context, { offset: 0 });
  const recorder = new AudioWorkletNode(context, 'hold-recorder');
  const recorded = new Promise<Float32Array>((resolve) => {
    recorder.port.onmessage = (e) => resolve(e.data);
  });
  source.connect(recorder);
  recorder.connect(context.destination);
  const param = new TrackedParam(source.offset, context);
  const start = context.currentTime + 0.05;
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(1, start + 0.4);
  source.start();
  const cancel = source.offset.cancelScheduledValues.bind(source.offset);
  const spy = vi.spyOn(source.offset, 'cancelScheduledValues').mockImplementation((time) => {
    const result = cancel(time);
    // A main-thread pause shorter than the future hold's scheduling lead.
    const until = performance.now() + 8;
    while (performance.now() < until) {
      /* let the audio thread render */
    }
    return result;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    param.holdAt(context.currentTime + 0.05);
    const data = await recorded;
    let largestStep = 0;
    for (let i = 1; i < data.length; i++)
      largestStep = Math.max(largestStep, Math.abs(data[i] - data[i - 1]));
    expect(largestStep).toBeLessThan(0.01);
  } finally {
    spy.mockRestore();
    source.stop();
    recorder.disconnect();
    await context.close();
  }
});
