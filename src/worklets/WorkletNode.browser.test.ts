import { expect, it } from 'vite-plus/test';
import { initProcessors } from './init-processors';
import { createDistortion } from './worklet-factory';

// Messages posted before startRendering() can land after the first quanta, so the
// documented pattern is to send them while rendering is suspended at frame 0.
it('applies a clipping mode sent while offline rendering is suspended', async () => {
  const context = new OfflineAudioContext(1, 128, 48000);
  await initProcessors(context);
  const distortion = createDistortion(context);
  distortion.setParam('clippingAmount', 1, 0);
  const source = new ConstantSourceNode(context, { offset: 0.5 });
  source.connect(distortion).connect(context.destination);
  source.start();
  void context.suspend(0).then(() => {
    distortion.sendProcessorMessage({ type: 'setLimitingMode', mode: 'soft-clipping' });
    void context.resume();
  });

  const rendered = await context.startRendering();

  for (const sample of rendered.getChannelData(0)) {
    expect(sample).toBeCloseTo(0.3 * Math.tanh(1), 5);
  }
  distortion.dispose();
});
