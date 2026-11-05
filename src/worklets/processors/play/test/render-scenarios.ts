import { makeParameters, startProcessor, TEST_SAMPLE_RATE } from './range-test-helpers';

export const renderScenarios = [
  'moving quantized loop',
  'ping-pong',
  'stretch',
  // The stretcher's fades overlap the loop crossfade, which pins the read head order.
  'looped stretch',
] as const;
export type RenderScenario = (typeof renderScenarios)[number];
export const QUANTUM = 128;

export async function createRenderScenario(scenario: RenderScenario, voice = 0) {
  const processor = await startProcessor([], [96 / TEST_SAMPLE_RATE, 192 / TEST_SAMPLE_RATE]);
  const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
  const left = Float32Array.from(
    { length: TEST_SAMPLE_RATE },
    (_, i) => 0.4 * Math.sin((2 * Math.PI * i) / 96) * (0.6 + 0.4 * Math.cos(i / 700)),
  );
  send({ type: 'voice:setBuffer', buffer: [left, Float32Array.from(left, (x) => -0.5 * x)] });
  send({ type: 'setLoopEnabled', value: scenario !== 'stretch' });
  send({ type: 'setLoopPingPong', value: scenario === 'ping-pong' });
  send({ type: 'setPanDriftEnabled', value: false });
  if (scenario === 'stretch' || scenario === 'looped stretch') {
    send({
      type: 'voice:setZeroCrossings',
      zeroCrossings: Array.from({ length: 501 }, (_, i) => (i * 96) / TEST_SAMPLE_RATE),
    });
    send({ type: 'setTimestretchMode', value: 'splice' });
  }
  send({ type: 'voice:start', triggerId: voice });
  const parameters = makeParameters({
    playbackRate: scenario === 'stretch' ? 2 : scenario === 'looped stretch' ? 1.7 : 1.5,
    loopEnd: (scenario === 'looped stretch' ? 5000 : 180) / TEST_SAMPLE_RATE,
  });
  if (scenario === 'moving quantized loop') {
    parameters.loopStart = new Float32Array(QUANTUM);
    parameters.loopEnd = new Float32Array(QUANTUM);
  }
  return {
    processor,
    parameters,
    output: [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]],
    render(block: number) {
      if (scenario === 'moving quantized loop') {
        for (let i = 0; i < QUANTUM; i++) {
          const frame = block * QUANTUM + i;
          parameters.loopStart[i] = (frame * 0.125) / TEST_SAMPLE_RATE;
          // Cross a quantization boundary while the window keeps moving.
          parameters.loopEnd[i] =
            parameters.loopStart[i] + (block < 24 ? 180 : 110) / TEST_SAMPLE_RATE;
        }
      }
      return processor.process([], this.output, parameters);
    },
  };
}
