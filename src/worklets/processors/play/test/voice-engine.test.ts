import { expect, it, vi } from 'vite-plus/test';
import { VoiceEngine } from '../engine/voice-engine.js';

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
