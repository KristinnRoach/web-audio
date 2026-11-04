/// <reference types="node" />

import { createHash } from 'node:crypto';
import { expect, it } from 'vite-plus/test';
import { setupProcessorGlobals } from './range-test-helpers';
import { createRenderScenario, renderScenarios } from './render-scenarios';

setupProcessorGlobals();

it.each(renderScenarios)('pins rendered stereo output for %s', async (scenario) => {
  const voice = await createRenderScenario(scenario);
  const rendered: number[] = [];
  for (let block = 0; block < 64; block++) {
    expect(voice.render(block)).toBe(true);
    for (let i = 0; i < 128; i++) {
      const [left, right] = voice.output[0];
      expect(Number.isFinite(left[i])).toBe(true);
      expect(right[i]).toBeCloseTo(-0.5 * left[i], 6);
      // Ignore sub-micro-level floating point differences across runtimes.
      rendered.push(Math.round(left[i] * 1e6));
    }
  }
  expect(Math.max(...rendered) - Math.min(...rendered)).toBeGreaterThan(100_000);
  // Full output fingerprint catches changes between the spot checks in other tests.
  expect(createHash('sha256').update(JSON.stringify(rendered)).digest('hex')).toMatchSnapshot();
});
