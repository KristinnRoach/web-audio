import { describe, expect, it } from 'vite-plus/test';
import { SpliceStretcher } from '../splice-stretch.js';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

setupProcessorGlobals();

describe('timestretch correction crossfade', () => {
  it('blends advancing stereo heads, then rejoins the unchanged transport', async () => {
    const results = await Promise.all(
      [false, true].map(async (enabled) => {
        const processor = await startProcessor();
        const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
        // Two rising zero crossings with different surrounding slopes.
        const left = Float32Array.from({ length: 6000 }, (_, i) =>
          i < 2500
            ? Math.max(-0.3, Math.min(0.3, (i - 1000) * 0.02))
            : Math.max(-0.3, Math.min(0.3, (i - 4000) * 0.001)),
        );
        send({ type: 'voice:setBuffer', buffer: [left, Float32Array.from(left, (x) => x * -0.5)] });
        send({
          type: 'voice:setZeroCrossings',
          zeroCrossings: [0, 1000, 4000, 5999].map((x) => x / TEST_SAMPLE_RATE),
        });
        send({ type: 'setLoopEnabled', value: false });
        send({ type: 'setPanDriftEnabled', value: false });
        send({ type: 'setTimestretchMode', value: 'splice' });
        const { timestretch } = processor as typeof processor & {
          timestretch: SpliceStretcher;
        };
        timestretch.crossfadeDurationMs = enabled ? 5 : 0;
        send({ type: 'voice:start' });
        const params = makeParameters({ playbackRate: 2 });
        processor.process([], [[new Float32Array(1), new Float32Array(1)]], params);
        processor.playbackPosition = 4000;
        timestretch.reset(1000);
        const output = [new Float32Array(300), new Float32Array(300)];
        processor.process([], [output], params);
        return { output, position: processor.playbackPosition };
      }),
    );

    const [original, faded] = results;
    expect(original.output[0][2]).toBeCloseTo(0.04);
    expect(faded.output[0][2]).toBeCloseTo(0.004, 4);
    expect(faded.output[0][3]).toBeGreaterThan(faded.output[0][2]);
    for (let i = 0; i < 300; i++) {
      expect(faded.output[1][i]).toBeCloseTo(faded.output[0][i] * -0.5);
    }
    expect(faded.output[0].slice(240)).toEqual(original.output[0].slice(240));
    expect(faded.position).toBe(original.position);

    const maxStep = (samples: Float32Array) =>
      Math.max(...samples.slice(1).map((x, i) => Math.abs(x - samples[i])));
    expect(maxStep(faded.output[0])).toBeLessThan(maxStep(original.output[0]));
  });
});
