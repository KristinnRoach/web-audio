import { expect, it, vi } from 'vite-plus/test';
import { VoiceEngine } from '../engine/voice-engine.js';
import { makeParameters } from './range-test-helpers';

const SR = 48_000;
const QUANTUM = 128;

// Deliberately without setupProcessorGlobals: any AudioWorklet global read throws here.
it('renders from injected time, randomness and message sink', () => {
  const post = vi.fn();
  const random = vi.fn(() => 0.75);
  const engine = new VoiceEngine({ sampleRate: SR, random, post });
  const parameters = Object.fromEntries(
    Object.entries({
      masterGain: 1,
      envGain: 1,
      velocity: 127,
      pan: 0,
      playbackRate: 1,
      detune: 0,
      loopStart: 0,
      loopEnd: 1024 / SR,
      startPoint: 0,
      endPoint: 1,
      loopDurationDriftAmount: 0.01,
      maxLoopCount: 999_999,
    }).map(([name, value]) => [name, new Float32Array([value])]),
  );

  engine.reportIdle(parameters, 0); // no source yet
  expect(post).not.toHaveBeenCalled();

  engine.setBuffer([Float32Array.from({ length: SR }, (_, i) => Math.sin(i / 10))]);
  engine.reportIdle(parameters, 0);
  expect(post).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'loop:range', idle: true }),
  );

  engine.loopEnabled = true;
  const startFrame = QUANTUM * 2 + 10;
  engine.start(7, startFrame / SR);
  expect(engine.canRender).toBe(true);

  const output = new Float32Array(QUANTUM);
  for (let block = 0; block < 2; block++) {
    engine.render([output], parameters, block * QUANTUM, (block * QUANTUM) / SR);
  }
  expect(output.every((value) => value === 0)).toBe(true);
  expect(random).not.toHaveBeenCalled();

  for (let block = 2; block < 12; block++) {
    engine.render([output.fill(0)], parameters, block * QUANTUM, (block * QUANTUM) / SR);
  }
  expect(output.some((value) => value !== 0)).toBe(true);
  expect(random).toHaveBeenCalled();
  const cycle = post.mock.calls.map(([message]) => message).find((m) => m.type === 'loop:cycle');
  // First wrap: the note starts at startFrame and reaches the drifted loop end.
  expect(cycle.triggerId).toBe(7);
  expect(cycle.time).toBeGreaterThan(startFrame / SR);
  expect(cycle.time).toBeLessThan(12 * (QUANTUM / SR));
});

it.each([null, [new Float32Array(256)]])(
  'releases all reader samples on buffer change',
  (replacement) => {
    const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post() {} });
    const samples = new Float32Array(256);
    engine.setBuffer([samples]);
    engine.start(1, 0);
    engine.render([new Float32Array(16)], makeParameters(), 0, 0);
    expect(engine.readHeads[0].source.samples).toBe(samples);
    // Include inactive heads that will not necessarily be reused by the next sample.
    for (const head of engine.readHeads) head.source.samples = samples;
    engine.setBuffer(replacement);
    expect(engine.readHeads.every((head) => head.source.samples === null)).toBe(true);
  },
);

it.each(['linear', 'hermite', 'sinc'] as const)(
  'excludes audio before the trim start during fractional playback in %s mode',
  (mode) => {
    const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post() {} });
    const samples = new Float32Array(512);
    samples[99] = 1;
    engine.setBuffer([samples]);
    engine.interpolation = mode;
    engine.start(1, 0);
    const output = new Float32Array(32);
    engine.render(
      [output],
      makeParameters({ startPoint: 100.25 / SR, endPoint: 400 / SR, playbackRate: 0.5 }),
      0,
      0,
    );
    expect(Array.from(output)).toEqual(Array(32).fill(0));
  },
);

it('keeps an outgoing head inside its saved trim when the current trim moves', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post() {} });
  const samples = new Float32Array(512);
  samples.fill(0.5, 100, 200);
  samples.fill(1, 0, 100);
  engine.setBuffer([samples]);
  engine.start(1, 0);
  engine.render(
    [new Float32Array(1)],
    makeParameters({ startPoint: 100 / SR, endPoint: 400 / SR }),
    0,
    0,
  );
  // A reverse outgoing head has crossed its old trim start. It must hold the
  // old endpoint (0.5), not the excluded sample (1) or the new endpoint (0).
  engine.loopCrossfade.start(99, -1, 32, false, 400, 100);
  const output = new Float32Array(1);
  engine.render([output], makeParameters({ startPoint: 200 / SR, endPoint: 500 / SR }), 1, 1 / SR);
  expect(output[0]).toBeCloseTo(0.5, 6);
});
