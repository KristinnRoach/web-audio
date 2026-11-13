import { expect, it, vi } from 'vite-plus/test';
import { BreakpointEnvelope } from '../engine/breakpoint-envelope.js';
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

const run = (env: BreakpointEnvelope, frames: number) =>
  Array.from({ length: frames }, () => env.next());

it('attacks, decays to sustain, holds, then releases to done', () => {
  const env = new BreakpointEnvelope(SR);
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
  const env = new BreakpointEnvelope(SR);
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
  engine.setEnvelope('gain', { shape: adsr('sustain') });
  engine.start(1, 0);

  const parameters = makeParameters({ endPoint: 1, loopEnd: 1 });
  const output = new Float32Array(128);
  engine.render([output], parameters, 0, 0);
  expect(output[64]).toBeGreaterThan(0);

  engine.release(0);
  for (let block = 1; block < 4; block++)
    engine.render([output.fill(0)], parameters, block * 128, 0);
  expect(posts.some((m) => 'type' in m && m.type === 'voice:ended')).toBe(true);
});

it('a release without a gain envelope stops the note', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]);
  engine.start(1, 0);
  engine.release(0.5);
  expect(engine.pendingStopFrame).toBe(0.5 * SR);
});

it('loop sync restarts on every sample loop wrap, fitted to the loop length', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]); // 1 s buffer
  engine.loopEnabled = true;
  engine.setEnvelope('gain', { shape: adsr('loop'), loopSync: true });
  const trigger = vi.spyOn(engine.envelopes.gain.envelope, 'trigger');
  engine.start(1, 0);

  // A 0.25 s loop: the full-buffer timeline plays 4x faster, once per wrap.
  const parameters = makeParameters({ endPoint: 1, loopEnd: 0.25 });
  for (let block = 0; block < 8; block++) {
    engine.render([new Float32Array(128)], parameters, block * 128, (block * 128) / SR);
  }
  expect(engine.loopCount).toBeGreaterThan(2);
  expect(trigger).toHaveBeenCalledTimes(1 + engine.loopCount!);
  expect(engine.envelopes.gain.envelope.timeScale).toBeCloseTo(4);
});

it('smooths a vertical segment instead of stepping in one sample', () => {
  const rate = 48_000;
  const engine = new VoiceEngine({ sampleRate: rate, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(rate).fill(0.5)]);
  engine.setEnvelope('gain', {
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
  engine.render([output], makeParameters({ endPoint: 1 }), 0, 0);
  // After the start fade, unsmoothed the jump is 0.5 * 0.8 = 0.4 in one sample.
  let maxStep = 0;
  for (let i = 32; i < output.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(output[i] - output[i - 1]));
  }
  expect(maxStep).toBeLessThan(0.02);
});

it('a detune envelope bends the playback rate the loop and read step use', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(SR)]);
  engine.setEnvelope('detune', {
    shape: {
      points: [
        { time: 0, value: 1 },
        { time: 1, value: 1 },
      ],
      mode: { type: 'once' },
      sustainPoint: 0,
      releasePoint: 0,
    },
    depth: 1200, // cents: one octave up
  });
  engine.start(1, 0);

  engine.render([new Float32Array(128)], makeParameters({ endPoint: 1 }), 0, 0);
  expect(engine.playbackPosition).toBeCloseTo(256, 0);
});

it('a pan envelope adds to the pan param, clamped to hard right', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]);
  engine.setPanDriftEnabled(false);
  const hardRight: EnvelopeShape = {
    points: [
      { time: 0, value: 1 },
      { time: 1, value: 1 },
    ],
    mode: { type: 'once' },
    sustainPoint: 0,
    releasePoint: 0,
  };
  engine.setEnvelope('pan', { shape: hardRight });
  engine.start(1, 0);

  const left = new Float32Array(128);
  const right = new Float32Array(128);
  engine.render([left, right], makeParameters({ pan: 0.5, endPoint: 1 }), 0, 0);
  expect(right[64]).toBeGreaterThan(0);
  expect(left[64]).toBe(0);
});

it('a filter envelope renders cents to the control output and leaves the audio alone', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]);
  const parameters = makeParameters({ endPoint: 1 });
  const render = () => {
    const audio = new Float32Array(128);
    const filter = new Float32Array(128);
    engine.render([audio], parameters, 0, 0, filter);
    return { audio, filter };
  };

  engine.start(1, 0);
  const without = render();
  expect(without.filter.every((value) => value === 0)).toBe(true); // inactive slot: 0 cents

  engine.setEnvelope('filter', { shape: adsr('sustain'), depth: 1200 });
  engine.start(2, 0);
  const withFilter = render();
  expect(withFilter.filter[10]).toBeGreaterThan(1000); // near the attack peak, in cents
  expect(withFilter.audio).toEqual(without.audio);
});

it('takes rate and velocity from voice:start, so the first note is synced and scaled', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]);
  engine.setEnvelope('gain', { shape: adsr('sustain'), playbackRateSync: true });
  // The playbackRate param is a multiplier now; a stale 1 must not leak into the note.
  const parameters = makeParameters({ endPoint: 1, loopEnd: 1 });

  engine.start(1, 0, { playbackRate: 2, velocity: 127 });
  engine.render([new Float32Array(128)], parameters, 0, 0);
  expect(engine.envelopes.gain.envelope.timeScale).toBe(2);
  expect(engine.noteRate).toBe(2);

  engine.start(2, 0, { playbackRate: 0.5, velocity: 0 });
  const output = new Float32Array(128);
  engine.render([output], parameters, 128, 0);
  expect(engine.envelopes.gain.envelope.timeScale).toBe(0.5);
  expect(output.every((v) => v === 0)).toBe(true); // velocity 0 from this note, not the last
});

it('glides the note rate from glideFrom and retunes on voice:setRate', () => {
  const engine = new VoiceEngine({ sampleRate: SR, random: () => 0.5, post: () => {} });
  engine.setBuffer([new Float32Array(SR).fill(0.5)]);
  const parameters = makeParameters({ endPoint: 1, loopEnd: 1 });

  engine.start(1, 0, { playbackRate: 2, glideFrom: 1, glideSeconds: 0.05 });
  engine.render([new Float32Array(128)], parameters, 0, 0);
  expect(engine.noteRate).toBeGreaterThan(1.9); // 128 ms at a 50 ms time constant
  expect(engine.noteRate).toBeLessThan(2);

  engine.setNoteRate(0, 4);
  engine.render([new Float32Array(128)], parameters, 128, 0);
  expect(engine.noteRate).toBe(4);
});
