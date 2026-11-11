/// <reference types="node" />

import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vite-plus/test';
import { setupProcessorGlobals, TEST_SAMPLE_RATE } from './range-test-helpers';
import { createRenderScenario, QUANTUM, renderScenarios } from './render-scenarios';

setupProcessorGlobals();

const interpolation = process.env.SAMPLE_PLAYER_INTERPOLATION ?? 'hermite';

it.skipIf(!process.env.SAMPLE_PLAYER_TIMING).each(renderScenarios)(
  'times 16 voices: %s',
  async (scenario) => {
    const voices = await Promise.all(
      Array.from({ length: 16 }, (_, i) => createRenderScenario(scenario, i)),
    );
    for (const { processor } of voices) {
      processor.port.onmessage?.({
        data: { type: 'setInterpolation', value: interpolation },
      } as MessageEvent);
    }
    // Do not time mock call recording or retain messages from thousands of cycles.
    for (const { processor } of voices) Object.assign(processor.port, { postMessage() {} });
    const times: number[] = [];
    const budgetMs = (QUANTUM / TEST_SAMPLE_RATE) * 1000;
    for (let block = 0; block < 600; block++) {
      // Restart before the non-looping stretch source ends, outside the timed region.
      if (block % 100 === 0) {
        for (const { processor } of voices)
          processor.port.onmessage?.({ data: { type: 'voice:start' } } as MessageEvent);
      }
      vi.stubGlobal('currentFrame', block * QUANTUM);
      vi.stubGlobal('currentTime', (block * QUANTUM) / TEST_SAMPLE_RATE);
      const start = performance.now();
      for (const voice of voices) voice.render(block % 100);
      const elapsed = performance.now() - start;
      if (block >= 100) times.push(elapsed);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        scenario,
        interpolation,
        voices: 16,
        sampleRate: TEST_SAMPLE_RATE,
        quantum: QUANTUM,
        budgetMs,
        p50Ms: times[250],
        p95Ms: times[475],
        maxMs: times.at(-1),
        overBudget: times.filter((ms) => ms > budgetMs).length,
        blocks: times.length,
      }),
    );
    expect(voices.every(({ output }) => output[0][0].some((sample) => sample !== 0))).toBe(true);
  },
);
