import { describe, expect, it } from 'vite-plus/test';
import { getKeytrackedValue } from '../engine/keytrack.js';
import {
  makeParameters,
  render,
  setupProcessorGlobals,
  TEST_SAMPLE_RATE,
  startProcessor,
} from './range-test-helpers';

describe('keytrack', () => {
  setupProcessorGlobals();

  it('tracks filter cutoff exponentially above and below the root', () => {
    const options = { rootNote: 60, depth: 1, mapping: 'exponential' as const };
    expect(getKeytrackedValue(1000, 60, options)).toBe(1000);
    expect(getKeytrackedValue(1000, 72, options)).toBe(2000);
    expect(getKeytrackedValue(1000, 48, options)).toBe(500);
  });

  it('supports partial, inverted and disabled exponential tracking', () => {
    expect(getKeytrackedValue(1000, 72, { depth: 0.5 })).toBeCloseTo(1000 * Math.SQRT2);
    expect(getKeytrackedValue(1000, 72, { depth: -1 })).toBe(500);
    expect(getKeytrackedValue(1000, 72, { depth: 0 })).toBe(1000);
  });

  it('supports custom roots and fractional MIDI notes', () => {
    expect(getKeytrackedValue(440, 69, { rootNote: 69 })).toBe(440);
    expect(getKeytrackedValue(440, 69.5, { rootNote: 69 })).toBeCloseTo(440 * 2 ** (0.5 / 12));
  });

  it('defaults to full exponential tracking relative to MIDI note 60', () => {
    expect(getKeytrackedValue(1000, 72)).toBe(2000);
  });

  it('tracks pan linearly in target units per semitone', () => {
    const options = { rootNote: 60, depth: 0.025, mapping: 'linear' as const };
    expect(getKeytrackedValue(0, 60, options)).toBe(0);
    expect(getKeytrackedValue(0, 72, options)).toBeCloseTo(0.3);
    expect(getKeytrackedValue(0, 48, options)).toBeCloseTo(-0.3);
    expect(getKeytrackedValue(0.2, 72, options)).toBeCloseTo(0.5);
    expect(getKeytrackedValue(0.2, 72, { ...options, depth: -0.025 })).toBeCloseTo(-0.1);
    expect(getKeytrackedValue(0.2, 72, { ...options, depth: 0 })).toBe(0.2);
  });

  it('leaves target clamping and rounding to the caller', () => {
    expect(getKeytrackedValue(0, 72, { mapping: 'linear', depth: 1 })).toBe(12);
    expect(getKeytrackedValue(1, 48)).toBe(0.5);
  });

  async function loopLengthSamples({
    detune = 0,
    playbackRate = 2,
    depth = 1,
    stretched = false,
  } = {}) {
    const processor = await startProcessor();
    const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
    send({ type: 'setKeytrackLoopAmount', value: depth });
    if (stretched) {
      send({
        type: 'voice:setPitchPeriods',
        periods: new Float32Array(101).fill(100),
        hopSamples: 480,
      });
      send({ type: 'setTimestretchMode', value: 'period' });
    }
    render(processor, makeParameters({ loopStart: 0.25, loopEnd: 0.5, playbackRate, detune }), 128);
    const loop = processor.port.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'loop:range')
      .at(-1);
    return (loop.loopEnd - loop.loopStart) * TEST_SAMPLE_RATE;
  }

  it('follows pitch modulation and ignores playback direction', async () => {
    expect(await loopLengthSamples()).toBeCloseTo(24000, 6);
    expect(await loopLengthSamples({ detune: -1200 })).toBeCloseTo(12000, 6);
    expect(await loopLengthSamples({ playbackRate: -2 })).toBeCloseTo(24000, 6);
  });

  it.each([
    { playbackRate: 2, depth: 0, stretched: false, expected: 12000 },
    { playbackRate: 2, depth: 0.5, stretched: false, expected: 16970 },
    { playbackRate: 0.5, depth: 1, stretched: false, expected: 6000 },
    { playbackRate: 2, depth: 0.5, stretched: true, expected: 8485 },
    { playbackRate: 2, depth: 1, stretched: true, expected: 6000 },
    { playbackRate: 0.5, depth: 1, stretched: true, expected: 24000 },
    { playbackRate: 1 / 65536, depth: 1, stretched: false, expected: 1 },
  ])('resolves loop keytracking in whole samples: %j', async ({ expected, ...options }) => {
    expect(await loopLengthSamples(options)).toBeCloseTo(expected, 6);
  });
});
