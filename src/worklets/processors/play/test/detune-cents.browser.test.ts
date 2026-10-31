import { expect, it } from 'vite-plus/test';

const SR = 48_000;

/**
 * Playhead speed (source samples per output sample) of a voice reading a linear
 * ramp. `envCents` sets the detune param, as the pitch envelope does; `lfoCents`
 * is a connected source, as the pitch LFO is.
 */
async function measureRate(playbackRate: number, envCents: number, lfoCents: number) {
  const context = new OfflineAudioContext(1, 256, SR);
  // Run `vp run build:worklets` before the browser suite.
  await context.audioWorklet.addModule('/dist/processors/processors.js');
  const node = new AudioWorkletNode(context, 'sample-player-processor', {
    outputChannelCount: [1],
    parameterData: {
      envGain: 1,
      velocity: 127,
      loopDurationDriftAmount: 0,
      playbackRate,
      detune: envCents,
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
  await new Promise<void>((resolve) => {
    node.port.onmessage = ({ data }) => {
      if (data.type === 'loop:enabled') resolve();
    };
    node.port.postMessage({ type: 'setTimestretchMode', value: 'off' });
    node.port.postMessage({ type: 'voice:start' });
    // voice:start has no ack; this reply confirms it landed before rendering.
    node.port.postMessage({ type: 'setLoopEnabled', value: false });
  });
  const lfo = new ConstantSourceNode(context, { offset: lfoCents });
  lfo.connect(node.parameters.get('detune')!);
  lfo.start();
  node.connect(context.destination);
  const samples = (await context.startRendering()).getChannelData(0);
  node.port.close();
  return (samples[200] - samples[100]) / 100;
}

it('applies detune as equal cents at any base rate and sums param + connected input', async () => {
  for (const base of [0.5, 1, 2]) {
    // Zero depth: playhead runs at the base rate (ramp step is 1 / 100_000 per sample).
    const plain = await measureRate(base, 0, 0);
    expect(plain * 100_000).toBeCloseTo(base, 3);
    // LFO peak alone: same interval regardless of base rate.
    expect((await measureRate(base, 0, 200)) / plain).toBeCloseTo(2 ** (200 / 1200), 4);
    // Envelope + LFO contributions add in cents.
    expect((await measureRate(base, 100, 200)) / plain).toBeCloseTo(2 ** (300 / 1200), 4);
  }
});
