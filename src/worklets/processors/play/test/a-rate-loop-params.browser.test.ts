import { expect, it } from 'vite-plus/test';

it('applies a loop-end step within a real render quantum', async () => {
  const context = new OfflineAudioContext(1, 256, 48_000);
  // Run `vp run build:worklets` before the browser suite.
  await context.audioWorklet.addModule('/dist/processors/processors.js');
  const node = new AudioWorkletNode(context, 'sample-player-processor', {
    outputChannelCount: [1],
    parameterData: {
      loopStart: 0,
      loopEnd: 192 / 48_000,
      // Pin everything that moves wrap positions or gain, so a default change
      // can't break this test. Drift is random.
      loopDurationDriftAmount: 0,
      playbackRate: 1,
      trimStart: 0,
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
      if (data.type === 'flushed') resolve();
    };
    // Processor state that resets only by message; voice:setBuffer doesn't touch it.
    node.port.postMessage({ type: 'voice:setKeytrackLoopAmount', value: 0 });
    node.port.postMessage({ type: 'voice:setLoopPingPong', value: false });
    node.port.postMessage({ type: 'voice:setTimestretchMode', value: 'off' });
    node.port.postMessage({ type: 'voice:start' });
    node.port.postMessage({ type: 'voice:setLoopEnabled', value: true });
    node.port.postMessage({ type: 'flush', id: 1 });
  });
  node.connect(context.destination);
  const audio = await context.startRendering();
  const samples = audio.getChannelData(0);
  // The step lands mid-pass, so the latched 192-sample pass plays on past it.
  expect(samples[150]).toBeCloseTo(150 / 100_000, 6);
  // The wrap at frame 192 lands in the shortened loop. Check past the wrap
  // crossfade (at most a quarter loop), before the new loop's own wrap.
  expect(samples[250]).toBeCloseTo(58 / 100_000, 6);
  expect(samples.every(Number.isFinite)).toBe(true);
  node.disconnect();
  node.port.close();
});
