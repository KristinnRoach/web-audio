import { describe, expect, it, vi } from 'vite-plus/test';
import { SamplePlayerVoice } from '../engine/sample-player-voice.js';
import { makeParameters } from './range-test-helpers';

const SR = 48_000;
const QUANTUM = 128;

// Deliberately without setupProcessorGlobals: any AudioWorklet global read throws here.
it('renders from injected time, randomness and message sink', () => {
  const postMessage = vi.fn();
  const random = vi.fn(() => 0.75);
  const voice = new SamplePlayerVoice({ sampleRate: SR, random, postMessage });
  const parameters = makeParameters({ loopEnd: 1024 / SR, loopDurationDriftAmount: 0.01 });

  voice.reportIdle(parameters, 0); // no source yet
  expect(postMessage).not.toHaveBeenCalled();

  voice.setBuffer([Float32Array.from({ length: SR }, (_, i) => Math.sin(i / 10))]);
  voice.reportIdle(parameters, 0);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'loop:range', idle: true }),
  );

  voice.loopEnabled = true;
  const startFrame = QUANTUM * 2 + 10;
  voice.start(7, startFrame / SR);
  expect(voice.canRender).toBe(true);

  const output = new Float32Array(QUANTUM);
  for (let block = 0; block < 2; block++) {
    voice.render([output], parameters, block * QUANTUM, (block * QUANTUM) / SR);
  }
  expect(output.every((value) => value === 0)).toBe(true);
  expect(random).not.toHaveBeenCalled();

  voice.render([output], parameters, 2 * QUANTUM, (2 * QUANTUM) / SR);
  expect(output.some((value) => value !== 0)).toBe(true);
  expect(random).toHaveBeenCalled();
});

it.each([null, [new Float32Array(256)]])(
  'releases all reader samples on buffer change',
  (replacement) => {
    const voice = new SamplePlayerVoice({ sampleRate: SR, random: () => 0.5, postMessage() {} });
    const samples = new Float32Array(256);
    voice.setBuffer([samples]);
    voice.start(1, 0);
    voice.render([new Float32Array(16)], makeParameters(), 0, 0);
    expect(voice.readHeads[0].source.samples).toBe(samples);
    // Include inactive heads that will not necessarily be reused by the next sample.
    for (const head of voice.readHeads) head.source.samples = samples;
    voice.setBuffer(replacement);
    expect(voice.readHeads.every((head) => head.source.samples === null)).toBe(true);
  },
);

it('keeps a moved pitch loop eligible for legato with timestretch off', () => {
  const voice = new SamplePlayerVoice({ sampleRate: SR, random: () => 0.5, postMessage() {} });
  voice.setBuffer([new Float32Array(SR)]);
  voice.loopEnabled = true;
  voice.enableLoopCrossfade = false;
  voice.start(1, 0);
  voice.render([new Float32Array(QUANTUM)], makeParameters({ loopEnd: 0.004 }), 0, 0);
  expect(voice.isInPitchLoop).toBe(true);

  const moved = makeParameters({ loopStart: 0.25, loopEnd: 0.254 });
  voice.render([new Float32Array(1)], moved, QUANTUM, QUANTUM / SR);
  expect(voice.isInPitchLoop).toBe(true);
});

describe('host stop', () => {
  const STOP_FRAME = 200;
  const FADE = 64;

  function playing() {
    const voice = new SamplePlayerVoice({ sampleRate: SR, random: () => 0.5, postMessage() {} });
    voice.setBuffer([new Float32Array(SR).fill(0.5)]);
    voice.start(1, 0);
    return voice;
  }

  function renderBlocks(voice: SamplePlayerVoice, blocks: number) {
    const output = new Float32Array(blocks * QUANTUM);
    for (let block = 0; block < blocks; block++) {
      if (!voice.canRender) break;
      const frame = block * QUANTUM;
      voice.render([output.subarray(frame, frame + QUANTUM)], makeParameters(), frame, frame / SR);
    }
    return output;
  }

  it('fades from the scheduled frame, then ends', () => {
    const voice = playing();
    voice.stop(STOP_FRAME / SR);
    const output = renderBlocks(voice, 3);
    const full = output[16];

    expect(output[STOP_FRAME - 1]).toBe(full);
    expect(output[STOP_FRAME]).toBeCloseTo(full * (1 - 1 / FADE), 6);
    expect(output[STOP_FRAME + FADE - 2]).toBeCloseTo(full / FADE, 6);
    expect(output.subarray(STOP_FRAME + FADE - 1).every((value) => value === 0)).toBe(true);
    expect(voice.isPlaying).toBe(false);
  });

  it('lets a following start supersede the stop', () => {
    const voice = playing();
    const full = renderBlocks(voice, 1)[16];
    voice.stop();
    voice.start(2, 0);
    const output = renderBlocks(voice, 2);
    expect(output[0]).toBe(0);
    expect(output.subarray(16).every((value) => value === full)).toBe(true);
  });

  it('ends a note silently when stopped before its scheduled start', () => {
    const voice = playing();
    voice.start(2, (2 * QUANTUM) / SR);
    voice.stop(QUANTUM / SR);
    expect(voice.isPlaying).toBe(false);
  });

  it('keeps fade progress when stopped again during the opening ramp', () => {
    const postMessage = vi.fn();
    const voice = new SamplePlayerVoice({ sampleRate: SR, random: () => 0.5, postMessage });
    voice.setBuffer([new Float32Array(SR).fill(0.5)]);
    voice.start(3, 0);
    const output = new Float32Array(96);
    voice.render([output.subarray(0, 8)], makeParameters(), 0, 0);
    voice.stop();
    voice.render([output.subarray(8, 20)], makeParameters(), 8, 8 / SR);
    voice.stop();
    voice.render([output.subarray(20)], makeParameters(), 20, 20 / SR);

    for (let frame = 0; frame < 8 + FADE; frame++) {
      const startGain = Math.min(frame / 16, 1);
      const stopGain = frame < 8 ? 1 : 1 - (frame - 8 + 1) / FADE;
      expect(output[frame]).toBeCloseTo(0.5 * startGain * stopGain, 6);
    }
    expect(output.subarray(8 + FADE - 1).every((value) => value === 0)).toBe(true);
    expect(voice.canRender).toBe(false);
    expect(postMessage.mock.calls.filter(([message]) => message.type === 'voice:ended')).toEqual([
      [{ type: 'voice:ended', triggerId: 3 }],
    ]);
  });
});

it.each([0.5, 1, 2])('fades a scheduled stereo start across blocks at playback rate %s', (rate) => {
  const voice = new SamplePlayerVoice({ sampleRate: SR, random: () => 0.5, postMessage() {} });
  voice.setBuffer([new Float32Array(SR).fill(0.5), new Float32Array(SR).fill(-0.25)]);
  voice.playbackDirection = 'reverse';
  const start = QUANTUM - 8;
  voice.start(1, start / SR);
  const output = [new Float32Array(2 * QUANTUM), new Float32Array(2 * QUANTUM)];
  for (let block = 0; block < 2; block++) {
    const frame = block * QUANTUM;
    voice.render(
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
