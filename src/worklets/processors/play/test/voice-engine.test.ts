import { describe, expect, it, vi } from 'vite-plus/test';
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
  // First wrap: the note starts at startFrame and reaches the drifted loop end.
  expect(engine.loopCount).toBeGreaterThan(0);
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
  // Second output frame has opening gain 1/16.
  expect(output[0] * 16).toBeCloseTo(0.5, 6);
});

describe('host stop', () => {
  const STOP_FRAME = 200;
  const FADE = 64;

  function playing() {
    const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post() {} });
    engine.setBuffer([new Float32Array(SR).fill(0.5)]);
    engine.start(1, 0);
    return engine;
  }

  function renderBlocks(engine: VoiceEngine, blocks: number) {
    const output = new Float32Array(blocks * QUANTUM);
    for (let block = 0; block < blocks; block++) {
      if (!engine.canRender) break;
      const frame = block * QUANTUM;
      engine.render([output.subarray(frame, frame + QUANTUM)], makeParameters(), frame, frame / SR);
    }
    return output;
  }

  it('fades from the scheduled frame, then ends', () => {
    const engine = playing();
    engine.stop(STOP_FRAME / SR);
    const output = renderBlocks(engine, 3);
    const full = output[16];

    expect(output[STOP_FRAME - 1]).toBe(full);
    expect(output[STOP_FRAME]).toBeCloseTo(full * (1 - 1 / FADE), 6);
    expect(output[STOP_FRAME + FADE - 2]).toBeCloseTo(full / FADE, 6);
    expect(output.subarray(STOP_FRAME + FADE - 1).every((value) => value === 0)).toBe(true);
    expect(engine.isPlaying).toBe(false);
  });

  it('lets a following start supersede the stop', () => {
    const engine = playing();
    const full = renderBlocks(engine, 1)[16];
    engine.stop();
    engine.start(2, 0);
    const output = renderBlocks(engine, 2);
    expect(output[0]).toBe(0);
    expect(output.subarray(16).every((value) => value === full)).toBe(true);
  });

  it('ends a note silently when stopped before its scheduled start', () => {
    const engine = playing();
    engine.start(2, (2 * QUANTUM) / SR);
    engine.stop(QUANTUM / SR);
    expect(engine.isPlaying).toBe(false);
  });

  it('keeps fade progress when stopped again during the opening ramp', () => {
    const post = vi.fn();
    const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post });
    engine.setBuffer([new Float32Array(SR).fill(0.5)]);
    engine.start(3, 0);
    const output = new Float32Array(96);
    engine.render([output.subarray(0, 8)], makeParameters(), 0, 0);
    engine.stop();
    engine.render([output.subarray(8, 20)], makeParameters(), 8, 8 / SR);
    engine.stop();
    engine.render([output.subarray(20)], makeParameters(), 20, 20 / SR);

    for (let frame = 0; frame < 8 + FADE; frame++) {
      const startGain = Math.min(frame / 16, 1);
      const stopGain = frame < 8 ? 1 : 1 - (frame - 8 + 1) / FADE;
      expect(output[frame]).toBeCloseTo(0.5 * startGain * stopGain, 6);
    }
    expect(output.subarray(8 + FADE - 1).every((value) => value === 0)).toBe(true);
    expect(engine.canRender).toBe(false);
    expect(post.mock.calls.filter(([message]) => message.type === 'voice:ended')).toEqual([
      [{ type: 'voice:ended', triggerId: 3 }],
    ]);
  });
});

it.each([0.5, 1, 2])('fades a scheduled stereo start across blocks at playback rate %s', (rate) => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post() {} });
  engine.setBuffer([new Float32Array(SR).fill(0.5), new Float32Array(SR).fill(-0.25)]);
  engine.reversePlayback = true;
  const start = QUANTUM - 8;
  engine.start(1, start / SR);
  const output = [new Float32Array(2 * QUANTUM), new Float32Array(2 * QUANTUM)];
  for (let block = 0; block < 2; block++) {
    const frame = block * QUANTUM;
    engine.render(
      output.map((channel) => channel.subarray(frame, frame + QUANTUM)),
      makeParameters({ playbackRate: rate }),
      frame,
      frame / SR,
    );
  }
  for (const channel of output) {
    const full = channel[start + 16];
    expect(full).not.toBe(0);
    expect(channel.subarray(0, start).every((value) => value === 0)).toBe(true);
    for (let frame = 0; frame <= 16; frame++) {
      expect(channel[start + frame]).toBeCloseTo((full * frame) / 16, 6);
    }
    expect(channel.subarray(start + 16).every((value) => value === full)).toBe(true);
  }
});
