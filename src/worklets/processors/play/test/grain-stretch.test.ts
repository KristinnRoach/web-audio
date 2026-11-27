import { describe, expect, it } from 'vite-plus/test';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

setupProcessorGlobals();

async function startGrainNote(source: Float32Array) {
  const processor = await startProcessor();
  const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
  send({
    type: 'voice:setBuffer',
    buffer: [source],
    durationSeconds: source.length / TEST_SAMPLE_RATE,
  });
  send({ type: 'voice:setLoopEnabled', value: false });
  send({ type: 'voice:setTimestretchMode', value: 'grain' });
  send({ type: 'voice:start', triggerId: 1 });
  processor.port.postMessage.mockClear(); // the buffer swap ended a note
  return processor;
}

function renderUntilEnded(
  processor: Awaited<ReturnType<typeof startProcessor>>,
  parameters: ReturnType<typeof makeParameters>,
  maxFrames: number,
) {
  const out: number[] = [];
  const block = new Float32Array(1);
  for (let frame = 0; frame < maxFrames; frame++) {
    processor.process([], [[block]], parameters);
    out.push(block[0]);
    const ended = processor.port.postMessage.mock.calls.some(([m]) => m.type === 'voice:ended');
    if (ended) break;
  }
  return out;
}

describe('grain timestretch', () => {
  it('keeps the source duration at any playback rate', async () => {
    const source = new Float32Array(TEST_SAMPLE_RATE / 2).fill(0.5);
    for (const playbackRate of [0.5, 2]) {
      const processor = await startGrainNote(source);
      const out = renderUntilEnded(
        processor,
        makeParameters({ playbackRate }),
        TEST_SAMPLE_RATE * 2,
      );
      // Half a second of source lasts half a second, plus the last fade.
      expect(Math.abs(out.length - source.length)).toBeLessThan(0.04 * TEST_SAMPLE_RATE);
    }
  });

  it('keeps a constant source constant through every hop', async () => {
    const processor = await startGrainNote(new Float32Array(TEST_SAMPLE_RATE).fill(0.5));
    const out = renderUntilEnded(processor, makeParameters({ playbackRate: 1.5 }), 20_000);
    expect(Math.min(...out.slice(100))).toBeCloseTo(0.5, 4);
    expect(Math.max(...out.slice(100))).toBeCloseTo(0.5, 4);
  });

  it('plays a sine at the note rate, not the time rate', async () => {
    const period = 96;
    const sine = Float32Array.from({ length: TEST_SAMPLE_RATE }, (_, i) =>
      Math.sin((2 * Math.PI * i) / period),
    );
    const processor = await startGrainNote(sine);
    const out = renderUntilEnded(processor, makeParameters({ playbackRate: 2 }), 24_000);
    // Rising zero crossings in a stretch between hops: one per period / 2 frames.
    const span = out.slice(2000, 12_000);
    const crossings = span.filter((v, i) => i > 0 && span[i - 1] < 0 && v >= 0).length;
    expect(crossings / (span.length / (period / 2))).toBeCloseTo(1, 1);
  });
});
