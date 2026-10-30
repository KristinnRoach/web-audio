import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  makeParameters,
  render,
  setupProcessorGlobals,
  TEST_SAMPLE_RATE,
  type TestProcessor,
} from './range-test-helpers';

// An idle voice reports the snapped loop and the loop before snapping, so the next
// note's loop envelopes can absorb the zero-crossing shortfall.
describe('idle loop range', () => {
  setupProcessorGlobals();
  beforeEach(() => vi.stubGlobal('currentTime', 0));

  const send = (processor: TestProcessor, data: Record<string, unknown>) =>
    processor.port.onmessage?.({ data } as MessageEvent);
  const load = (processor: TestProcessor) => {
    send(processor, {
      type: 'voice:setBuffer',
      buffer: [new Float32Array(TEST_SAMPLE_RATE)],
      durationSeconds: 1,
    });
    send(processor, { type: 'voice:setZeroCrossings', zeroCrossings: [0.01, 0.49] });
  };
  const idleReports = (processor: TestProcessor) =>
    processor.port.postMessage.mock.calls.map(([m]) => m).filter((m) => m.idle);

  async function idleProcessor() {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const processor = new SamplePlayerProcessor() as unknown as TestProcessor;
    load(processor);
    return processor;
  }

  const parameters = makeParameters({ loopStart: 0, loopEnd: 0.5, endPoint: 1 });

  it('reports the processed loop with its requested length, once per change', async () => {
    const processor = await idleProcessor();
    render(processor, parameters, 3);

    const reports = idleReports(processor);
    expect(reports).toHaveLength(1);
    expect(reports[0].loopStart).toBeCloseTo(0.01, 6);
    expect(reports[0].loopEnd).toBeCloseTo(0.49, 6);
    expect(reports[0].requestedLoopSeconds).toBeCloseTo(0.5, 6);
  });

  it('reports again after reloading the same audio', async () => {
    const processor = await idleProcessor();
    render(processor, parameters, 1);
    load(processor);
    vi.stubGlobal('currentTime', 1);
    render(processor, parameters, 1);

    const [first, second] = idleReports(processor);
    expect(second).toEqual(first);
  });

  it('throttles reports and sends the latest change once the interval passes', async () => {
    const processor = await idleProcessor();
    render(processor, parameters, 1);
    render(processor, makeParameters({ loopStart: 0, loopEnd: 0.4, endPoint: 1 }), 1);
    expect(idleReports(processor)).toHaveLength(1);

    vi.stubGlobal('currentTime', 1);
    render(processor, makeParameters({ loopStart: 0, loopEnd: 0.4, endPoint: 1 }), 1);
    const reports = idleReports(processor);
    expect(reports).toHaveLength(2);
    expect(reports[1].requestedLoopSeconds).toBeCloseTo(0.4, 6);
  });

  it('reports the loop keytrack the voice must apply at the note rate', async () => {
    const processor = await idleProcessor();
    send(processor, { type: 'setKeytrackLoopAmount', value: 0.5 });
    render(processor, parameters, 1);
    send(processor, { type: 'syncLoopToTempo', value: true });
    vi.stubGlobal('currentTime', 1);
    render(processor, parameters, 1);

    const [keytracked, tempoSynced] = idleReports(processor);
    expect(keytracked.keytrackAmount).toBe(0.5);
    expect(tempoSynced.keytrackAmount).toBe(0); // tempo sync overrides keytrack
  });

  it('reports no correction for tempo-synced loops', async () => {
    const processor = await idleProcessor();
    send(processor, { type: 'syncLoopToTempo', value: true });
    render(processor, parameters, 1);

    const [report] = idleReports(processor);
    expect(report.loopEnd - report.loopStart).toBeCloseTo(report.requestedLoopSeconds, 9);
  });
});
