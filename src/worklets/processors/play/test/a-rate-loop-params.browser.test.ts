import { expect, it } from 'vite-plus/test';

it('applies a loop-end step within a real render quantum', async () => {
  const context = new OfflineAudioContext(1, 256, 48_000);
  // Run `vp run build:worklets` before the browser suite.
  await context.audioWorklet.addModule('/dist/processors/processors.js');
  const node = new AudioWorkletNode(context, 'sample-player-processor', {
    outputChannelCount: [1],
    parameterData: {
      velocity: 127,
      loopStart: 0,
      loopEnd: 192 / 48_000,
      // Pin everything that moves wrap positions or gain, so a default change
      // can't break this test. Drift is random.
      loopDurationDriftAmount: 0,
      playbackRate: 1,
      startPoint: 0,
      masterGain: 1,
    },
  });
  await new Promise<void>((resolve) => {
    node.port.onmessage = ({ data }) => {
      if (data.type === 'voice:loaded') resolve();
    };
    node.port.postMessage({
      type: 'voice:setBuffer',
      buffer: [Float32Array.from({ length: 4800 }, (_, i) => i / 100_000)],
      durationSeconds: 0.1,
    });
  });
  const loopEnd = node.parameters.get('loopEnd')!;
  expect(loopEnd.automationRate).toBe('a-rate');
  loopEnd.setValueAtTime(95.5 / 48_000, 65 / 48_000);
  await new Promise<void>((resolve) => {
    node.port.onmessage = ({ data }) => {
      if (data.type === 'loop:enabled') resolve();
    };
    // Processor state that resets only by message; voice:setBuffer doesn't touch it.
    node.port.postMessage({ type: 'setKeytrackLoopAmount', value: 0 });
    node.port.postMessage({ type: 'setLoopPingPong', value: false });
    node.port.postMessage({ type: 'setTimestretchMode', value: 'off' });
    node.port.postMessage({ type: 'voice:start' });
    node.port.postMessage({ type: 'setLoopEnabled', value: true });
  });
  node.connect(context.destination);
  const audio = await context.startRendering();
  const samples = audio.getChannelData(0);
  expect(samples[95]).toBeCloseTo(95 / 100_000, 6);
  // The wrap lands at frame 96. Check half a loop later, past any loop-jump
  // crossfade (at most a quarter loop), where the playhead reads loopStart + 48.5.
  expect(samples[144]).toBeCloseTo(48.5 / 100_000, 6);
  expect(samples.every(Number.isFinite)).toBe(true);
  node.disconnect();
  node.port.close();
});
