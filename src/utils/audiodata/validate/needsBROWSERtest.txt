import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isValidAudioBuffer } from './audiobuffer';
import { generateTestBuffer } from '../generate/generateTestBuffer';
import {
  getOfflineAudioContext,
  releaseOfflineContext,
  clearAllOfflineContexts,
} from '../../../context';

describe('isValidAudioBuffer', () => {
  const config = { length: 44100, sampleRate: 44100 };
  let ctx: OfflineAudioContext;

  beforeEach(() => {
    clearAllOfflineContexts();
    ctx = getOfflineAudioContext(config);
  });

  afterEach(() => {
    releaseOfflineContext(config);
    clearAllOfflineContexts();
  });

  it('returns false for null or undefined buffer', () => {
    expect(isValidAudioBuffer(null)).toBe(false);
    expect(isValidAudioBuffer(undefined)).toBe(false);
  });

  it('validates a proper audio buffer', () => {
    const buffer = generateTestBuffer(ctx, {
      duration: 1,
      channels: 1,
    });
    expect(isValidAudioBuffer(buffer)).toBe(true);
  });

  it('rejects buffers that are too short', () => {
    const shortCtx = getOfflineAudioContext({ length: 44, sampleRate: 44100 }); // 1ms
    const buffer = generateTestBuffer(shortCtx, {
      duration: 0.001,
    });
    expect(isValidAudioBuffer(buffer)).toBe(false);
  });

  it('rejects buffers that are too long', () => {
    const longCtx = getOfflineAudioContext({
      length: 44100 * 61,
      sampleRate: 44100,
    }); // 61 seconds
    const buffer = generateTestBuffer(longCtx, {
      duration: 61,
    });
    expect(isValidAudioBuffer(buffer)).toBe(false);
  });

  it('validates multi-channel buffers', () => {
    const buffer = generateTestBuffer(ctx, {
      duration: 1,
      channels: 2,
    });
    expect(isValidAudioBuffer(buffer)).toBe(true);
  });

  it('rejects buffers with too many channels', () => {
    const buffer = generateTestBuffer(ctx, {
      duration: 1,
      channels: 33,
    });
    expect(isValidAudioBuffer(buffer)).toBe(false);
  });

  it('rejects silent buffers (all zeros)', () => {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    expect(isValidAudioBuffer(buffer)).toBe(false);
  });

  // New test cases for better coverage
  it('rejects buffer with invalid channel data', () => {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    // Use Vitest's spyOn instead of Jest's
    vi.spyOn(buffer, 'getChannelData').mockImplementation(() => null as any);
    expect(isValidAudioBuffer(buffer)).toBe(false);
  });

  it('handles edge case with minimum allowed duration', () => {
    const minCtx = getOfflineAudioContext({
      length: Math.ceil(0.01 * 44100), // Exactly 0.01 seconds
      sampleRate: 44100,
    });
    const buffer = generateTestBuffer(minCtx, {
      duration: 0.01,
      frequency: 440,
    });
    expect(isValidAudioBuffer(buffer)).toBe(true);
  });

  it('validates buffer with minimal non-zero content', () => {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    data[0] = 0.0001; // Set just one sample to a very small non-zero value
    expect(isValidAudioBuffer(buffer)).toBe(true);
  });
});
