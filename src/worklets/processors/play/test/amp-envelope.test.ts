import { expect, it, vi } from 'vite-plus/test';
import { AmpEnvelope } from '../engine/amp-envelope.js';
import { VoiceEngine } from '../engine/voice-engine.js';
import { makeParameters } from './range-test-helpers';
import type { EnvelopeShape } from '../../../../nodes/modulators/envelope';

const SR = 1000;

const adsr = (mode: EnvelopeShape['mode']['type']): EnvelopeShape => ({
  points: [
    { time: 0, value: 0 },
    { time: 0.01, value: 1, curve: 'exponential' },
    { time: 0.02, value: 0.5 },
    { time: 0.03, value: 0 },
  ],
  mode: { type: mode },
  sustainPoint: 2,
  releasePoint: 2,
});

const run = (env: AmpEnvelope, frames: number) => Array.from({ length: frames }, () => env.next());

it('attacks, decays to sustain, holds, then releases to done', () => {
  const env = new AmpEnvelope(SR);
  env.shape = adsr('sustain');
  env.trigger();
  const held = run(env, 100);
  expect(held[0]).toBe(0);
  expect(held[10]).toBe(1);
  expect(held[20]).toBe(0.5);
  expect(held[99]).toBe(0.5);
  expect(env.done).toBe(false);

  env.release();
  const tail = run(env, 10);
  expect(tail[0]).toBe(0.5);
  expect(tail[5]).toBeCloseTo(0.25);
  expect(env.next()).toBe(0);
  expect(env.done).toBe(true);
});

it('loops the whole shape until release', () => {
  const env = new AmpEnvelope(SR);
  env.shape = adsr('loop');
  env.trigger();
  const out = run(env, 70);
  expect(out[10]).toBe(1);
  expect(out[40]).toBe(1); // second cycle's attack peak
  expect(env.done).toBe(false);
});

it('drives the engine output and ends the note when the release tail does', () => {
  const posts: object[] = [];
  const engine = new VoiceEngine({
    sampleRate: SR,
    random: () => 0.5,
    post: (m: object) => void posts.push(m),
  });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]);
  engine.setAmpEnvelope({ shape: adsr('sustain') });
  engine.start(1, 0);

  const parameters = makeParameters({ envGain: 0, endPoint: 1, loopEnd: 1 });
  const output = new Float32Array(128);
  engine.render([output], parameters, 0, 0);
  expect(output[64]).toBeGreaterThan(0); // envGain is 0, so this is the new envelope

  engine.release(0);
  for (let block = 1; block < 4; block++)
    engine.render([output.fill(0)], parameters, block * 128, 0);
  expect(posts.some((m) => 'type' in m && m.type === 'voice:ended')).toBe(true);
});

it('loop sync restarts on every sample loop wrap, fitted to the loop length', () => {
  const posts: { type?: string }[] = [];
  const engine = new VoiceEngine({
    sampleRate: SR,
    random: () => 0.5,
    post: (m: object) => void posts.push(m),
  });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]); // 1 s buffer
  engine.loopEnabled = true;
  engine.setAmpEnvelope({ shape: adsr('loop'), loopSync: true });
  const trigger = vi.spyOn(engine.ampEnvelope, 'trigger');
  engine.start(1, 0);

  // A 0.25 s loop: the full-buffer timeline plays 4x faster, once per wrap.
  const parameters = makeParameters({ envGain: 0, endPoint: 1, loopEnd: 0.25 });
  for (let block = 0; block < 8; block++) {
    engine.render([new Float32Array(128)], parameters, block * 128, (block * 128) / SR);
  }
  const wraps = posts.filter((m) => m.type === 'loop:cycle').length;
  expect(wraps).toBeGreaterThan(2);
  expect(trigger).toHaveBeenCalledTimes(1 + wraps);
  expect(engine.ampEnvelope.timeScale).toBeCloseTo(4);
});

it('smooths a vertical segment instead of stepping in one sample', () => {
  const rate = 48_000;
  const engine = new VoiceEngine({ sampleRate: rate, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(rate).fill(0.5)]);
  engine.setAmpEnvelope({
    shape: {
      points: [
        { time: 0, value: 1 },
        { time: 0.002, value: 1 },
        { time: 0.002 + 1e-6, value: 0.2 }, // the UI's "two points at the same time"
        { time: 0.01, value: 0.2 },
      ],
      mode: { type: 'once' },
      sustainPoint: 0,
      releasePoint: 0,
    },
  });
  engine.start(1, 0);

  const output = new Float32Array(256);
  engine.render([output], makeParameters({ envGain: 0, endPoint: 1 }), 0, 0);
  // After the start fade, unsmoothed the jump is 0.5 * 0.8 = 0.4 in one sample.
  let maxStep = 0;
  for (let i = 32; i < output.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(output[i] - output[i - 1]));
  }
  expect(maxStep).toBeLessThan(0.02);
});
