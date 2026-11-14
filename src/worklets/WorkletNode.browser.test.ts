import { expect, it } from 'vite-plus/test';
import { initProcessors } from './init-processors';
import { createDistortion } from './worklet-factory';

it('applies the requested clipping mode from the first offline quantum', async () => {
  const context = new OfflineAudioContext(1, 128, 48000);
  await initProcessors(context);
  const distortion = createDistortion(context);
  distortion.setParam('clippingAmount', 1, 0);
  distortion.sendProcessorMessage({ type: 'setLimitingMode', mode: 'soft-clipping' });
  const source = new ConstantSourceNode(context, { offset: 0.5 });
  source.connect(distortion).connect(context.destination);
  source.start();

  const rendered = await context.startRendering();

  for (const sample of rendered.getChannelData(0)) {
    expect(sample).toBeCloseTo(0.3 * Math.tanh(1), 5);
  }
  distortion.dispose();
});
