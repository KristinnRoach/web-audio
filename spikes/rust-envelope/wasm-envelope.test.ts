/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vite-plus/test';
import { BreakpointEnvelope } from '../../src/worklets/processors/play/engine/breakpoint-envelope.js';
import type { EnvelopeShape } from '../../src/nodes/modulators/envelope';
import { instantiateEnvelopeWasm, WasmBreakpointEnvelope } from './wasm-envelope.js';

const SR = 48_000;
const QUANTUM = 128;
// Run `vp run build:wasm` after changing src/lib.rs.
const wasmBytes = readFileSync(new URL('./breakpoint_envelope.wasm', import.meta.url));

const shape = (mode: EnvelopeShape['mode']['type']): EnvelopeShape => ({
  points: [
    { time: 0, value: 0 },
    { time: 0.01, value: 1, curve: 'exponential' },
    { time: 0.03, value: 0.5, curve: 'step' },
    { time: 0.04, value: 0.3 },
    { time: 0.2, value: 0, curve: 'exponential' },
    { time: 0.25, value: 0 },
  ],
  mode: { type: mode },
  sustainPoint: 3,
  releasePoint: 3,
});

/** Applies the same calls to both envelopes, then checks `blocks` blocks sample by sample. */
function comparePair() {
  const js = new BreakpointEnvelope(SR);
  const wasm = new WasmBreakpointEnvelope(instantiateEnvelopeWasm(wasmBytes), SR);
  return {
    both(act: (envelope: BreakpointEnvelope | WasmBreakpointEnvelope) => void) {
      act(js);
      act(wasm);
    },
    expectSameBlocks(blocks: number) {
      for (let block = 0; block < blocks; block++) {
        const rendered = wasm.render(QUANTUM);
        for (let i = 0; i < QUANTUM; i++) {
          const expected = js.next();
          // Output is Float32 and the two pow() implementations can differ in the last bits.
          if (Math.abs(rendered[i] - expected) > 1e-6)
            throw new Error(`block ${block} sample ${i}: ${rendered[i]} != ${expected}`);
        }
        expect(wasm.done).toBe(js.done);
        expect(wasm.released).toBe(js.released);
      }
    },
  };
}

it.each(['once', 'sustain', 'loop'] as const)('matches the JS envelope: %s', (mode) => {
  const pair = comparePair();
  pair.both((envelope) => {
    envelope.shape = shape(mode);
    envelope.trigger();
  });
  pair.expectSameBlocks(150);
  pair.both((envelope) => envelope.release());
  pair.expectSameBlocks(100);
});

it('matches the JS envelope when released mid-attack at double speed', () => {
  const pair = comparePair();
  pair.both((envelope) => {
    envelope.shape = shape('sustain');
    envelope.timeScale = 2;
    envelope.trigger();
  });
  pair.expectSameBlocks(1);
  pair.both((envelope) => envelope.release());
  pair.expectSameBlocks(50);
});

it('matches the JS envelope across live value edits', () => {
  const pair = comparePair();
  const original = shape('sustain');
  const edited = {
    ...original,
    points: original.points.map((point) => ({ ...point, value: point.value * 0.5 + 0.1 })),
  };
  pair.both((envelope) => {
    envelope.shape = shape('sustain');
    envelope.trigger();
  });
  // Mid-attack: the running segment re-aims.
  pair.expectSameBlocks(2);
  pair.both((envelope) => {
    envelope.shape = edited;
    envelope.retarget();
  });
  // Held at sustain: glides to the edited value.
  pair.expectSameBlocks(40);
  pair.both((envelope) => {
    envelope.shape = shape('sustain');
    envelope.retarget();
  });
  pair.expectSameBlocks(40);
});

// 16 voices with four envelopes each, as in voice-timing.test.ts.
it.skipIf(!process.env.SAMPLE_PLAYER_TIMING)('times 64 looping envelopes', () => {
  const wasm = instantiateEnvelopeWasm(wasmBytes);
  const make = <T extends BreakpointEnvelope | WasmBreakpointEnvelope>(create: () => T) =>
    Array.from({ length: 64 }, () => {
      const envelope = create();
      envelope.shape = shape('loop');
      envelope.trigger();
      return envelope;
    });
  const jsEnvelopes = make(() => new BreakpointEnvelope(SR));
  const blockEnvelopes = make(() => new WasmBreakpointEnvelope(wasm, SR));
  const sampleEnvelopes = make(() => new WasmBreakpointEnvelope(wasm, SR));
  let sink = 0;
  const variants = {
    js() {
      for (const envelope of jsEnvelopes) for (let i = 0; i < QUANTUM; i++) sink += envelope.next();
    },
    // One call per block; the engine reads the block back from WASM memory.
    wasmBlock() {
      for (const envelope of blockEnvelopes) {
        const out = envelope.render(QUANTUM);
        for (let i = 0; i < QUANTUM; i++) sink += out[i];
      }
    },
    // One call per sample, which is how voice-envelopes.js consumes an envelope today.
    wasmPerSample() {
      for (const envelope of sampleEnvelopes)
        for (let i = 0; i < QUANTUM; i++) sink += envelope.next();
    },
  };
  const result: Record<string, unknown> = {
    envelopes: 64,
    sampleRate: SR,
    quantum: QUANTUM,
    budgetMs: (QUANTUM / SR) * 1000,
  };
  for (const [name, render] of Object.entries(variants)) {
    const times: number[] = [];
    for (let block = 0; block < 2100; block++) {
      const start = performance.now();
      render();
      if (block >= 100) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    result[name] = { p50Ms: times[1000], p95Ms: times[1900], maxMs: times.at(-1) };
  }
  console.log(JSON.stringify(result));
  expect(Number.isFinite(sink)).toBe(true);
});
