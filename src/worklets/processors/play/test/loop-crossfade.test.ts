import { describe, expect, it } from 'vite-plus/test';
import { LoopCrossfade } from '../loop-crossfade.js';
import { makeParameters, setupProcessorGlobals, startProcessor } from './range-test-helpers';

setupProcessorGlobals();

describe('LoopCrossfade', () => {
  it('fades over its length in source samples at any rate', () => {
    const fade = new LoopCrossfade();
    fade.start(100, 8);
    expect(fade.mix).toBe(0);
    fade.advance(-2);
    expect(fade.outgoingPosition).toBe(98);
    expect(fade.mix).toBe(0.25);
    fade.advance(-6);
    expect(fade.outgoingPosition).toBeNull();
    expect(fade.mix).toBe(1);
  });

  it('stays idle for fades shorter than a sample', () => {
    const fade = new LoopCrossfade();
    fade.start(100, 0.5);
    expect(fade.outgoingPosition).toBeNull();
  });
});

describe('loop jump crossfade', () => {
  it('continues the source past the loop end, then settles on the loop start', async () => {
    // Ramp 0..1 across the buffer: a jump from loop end to start is a large step.
    const ramp = Float32Array.from({ length: 48_000 }, (_, i) => i / 48_000);
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'voice:setBuffer', buffer: [ramp], durationSeconds: 1 });
    send({ type: 'voice:start', triggerId: 1 });
    const output = new Float32Array(7000);
    processor.process([], [[output]], makeParameters({ loopEnd: 0.125 }));

    const steps = output.slice(1).map((value, i) => Math.abs(value - output[i]));
    // No single-frame step anywhere near the 0.125 jump
    expect(Math.max(...steps)).toBeLessThan(0.01);
    // After the fade, playback reads the loop start again
    expect(output[6000 + 300]).toBeCloseTo(300 / 48_000, 4);
  });
});
