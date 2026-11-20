import { expect, it } from 'vite-plus/test';
import { BreakpointEnvelope } from '../../src/worklets/processors/play/engine/breakpoint-envelope.js';

const SR = 48_000;
const FRAMES = 4800;

const shape = {
  points: [
    { time: 0, value: 0 },
    { time: 0.01, value: 1, curve: 'exponential' },
    { time: 0.05, value: 0.2 },
    { time: 0.08, value: 0 },
  ],
  mode: { type: 'once' },
  sustainPoint: 0,
  releasePoint: 0,
};

it('runs the Rust envelope inside an AudioWorklet', async () => {
  const context = new OfflineAudioContext(1, FRAMES, SR);
  await context.audioWorklet.addModule('/spikes/rust-envelope/wasm-envelope-processor.js');
  const wasmBytes = await (
    await fetch('/spikes/rust-envelope/breakpoint_envelope.wasm')
  ).arrayBuffer();
  const node = new AudioWorkletNode(context, 'wasm-envelope-processor', {
    numberOfInputs: 0,
    outputChannelCount: [1],
    processorOptions: { wasmBytes, shape },
  });
  node.connect(context.destination);
  const rendered = (await context.startRendering()).getChannelData(0);

  const js = new BreakpointEnvelope(SR);
  js.shape = shape;
  js.trigger();
  let worst = 0;
  for (let i = 0; i < FRAMES; i++) worst = Math.max(worst, Math.abs(rendered[i] - js.next()));
  expect(rendered[480]).toBeCloseTo(1, 5);
  expect(worst).toBeLessThan(1e-6);
});
