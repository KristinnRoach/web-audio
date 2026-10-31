import { describe, expect, it } from 'vite-plus/test';
import { DurationPreserver, MAX_DRIFT_MS } from '../duration-preservation.js';

function samplesWithSlopes(slopes: Record<number, 'rising' | 'falling'>) {
  const samples = new Float32Array(32);
  for (const [position, slope] of Object.entries(slopes)) {
    const index = Number(position);
    samples[index - 1] = slope === 'rising' ? -1 : 1;
    samples[index + 1] = slope === 'rising' ? 1 : -1;
  }
  return samples;
}

describe('DurationPreserver', () => {
  it.each([0, 0.1, 2, 5, 12.5])('uses the configured %s ms overlap duration', (milliseconds) => {
    const preserver = new DurationPreserver(1000);
    const samples = new Float32Array(200);
    samples[21] = samples[101] = 1;
    preserver.crossfadeDurationMs = milliseconds;
    preserver.setEnabled(true, 20);
    preserver.prepareCorrection(true, 100, 1, [20, 100], samples);
    let frames = 0;
    let position = 100;
    while (preserver.outgoingPosition !== null && frames < 200) {
      position = preserver.advance(true, position, 1, frames === 0 ? 20 : null, false, 0, 200);
      frames++;
    }
    expect(frames).toBe(milliseconds === 0 ? 0 : Math.max(2, Math.round(milliseconds)));
  });

  // At 1 kHz one ms is one sample. Jumps recur every maxDrift / |rate - 1| output samples,
  // and the fade may use at most half of that. The requested fade is longer than the cap.
  it.each([4, 2])('caps the fade to half the jump interval at rate %s', (rate) => {
    const maxDrift = MAX_DRIFT_MS;
    const start = 20;
    const playhead = start + maxDrift + 10;
    const length = playhead + 10 * maxDrift;
    const preserver = new DurationPreserver(1000);
    const samples = new Float32Array(length);
    samples[start + 1] = samples[playhead + 1] = 1;
    preserver.crossfadeDurationMs = 10 * maxDrift;
    preserver.setEnabled(true, start);
    preserver.prepareCorrection(true, playhead, rate, [start, playhead], samples);
    let frames = 0;
    let position = playhead;
    while (preserver.outgoingPosition !== null && frames < length) {
      position = preserver.advance(
        true,
        position,
        rate,
        frames === 0 ? start : null,
        false,
        0,
        length,
      );
      frames++;
    }
    expect(frames).toBe(Math.floor(maxDrift / Math.abs(Math.abs(rate) - 1) / 2));
  });

  it.each([1, -1])('finishes a bounded overlap without changing transport at rate %s', (rate) => {
    const preserver = new DurationPreserver(1000);
    const samples = new Float32Array(200);
    samples[21] = samples[101] = 1;
    preserver.setEnabled(true, 20);
    preserver.crossfadeDurationMs = 5;

    const correction = preserver.prepareCorrection(true, 100, rate, [20, 100], samples);
    expect(correction?.resetTarget).toBe(20);
    expect(preserver.outgoingPosition).toBe(100);
    expect(preserver.crossfadeMix).toBe(0);
    let position = preserver.advance(true, 100, rate, 20, false, 0, 200);
    for (let i = 1; i < 5; i++) {
      expect(preserver.outgoingPosition).toBe(100 + i * rate);
      expect(preserver.crossfadeMix).toBeGreaterThan(0);
      expect(preserver.crossfadeMix).toBeLessThanOrEqual(1);
      // No competing correction while the fade is active.
      expect(preserver.prepareCorrection(true, position, rate, [20, 100], samples)).toBeNull();
      position = preserver.advance(true, position, rate, null, false, 0, 200);
    }
    expect(preserver.outgoingPosition).toBeNull();
    expect(position).toBe(20 + 4 * rate);
    expect(preserver.timelinePosition).toBe(20 + 5 * rate);
  });

  it.each(['toggle', 'reset', 'inactive', 'direction', 'boundary'])(
    'clears an overlap on %s',
    (reason) => {
      const preserver = new DurationPreserver(1000);
      const samples = new Float32Array(200);
      samples[21] = samples[101] = 1;
      preserver.setEnabled(true, 20);
      preserver.crossfadeDurationMs = 5;
      preserver.prepareCorrection(true, 100, 1, [20, 100], samples);
      expect(preserver.outgoingPosition).toBe(100);
      if (reason === 'toggle') preserver.crossfadeDurationMs = 0;
      if (reason === 'reset') preserver.reset();
      if (reason === 'inactive') preserver.prepareCorrection(false, 20, 1, [], samples);
      if (reason === 'direction') preserver.prepareCorrection(true, 20, -1, [], samples);
      if (reason === 'boundary') preserver.prepareCorrection(true, 20, 1, [], samples, 0, 100);
      expect(preserver.outgoingPosition).toBeNull();
    },
  );

  it('shortens the fade at an edge', () => {
    const preserver = new DurationPreserver(1000);
    const samples = new Float32Array(103);
    samples[21] = samples[101] = 1;
    preserver.setEnabled(true, 20);
    preserver.crossfadeDurationMs = 5;
    preserver.prepareCorrection(true, 100, 1, [20, 100], samples);
    preserver.advance(true, 100, 1, 20, false, 0, 103);
    expect(preserver.crossfadeMix).toBe(0.5);
    preserver.advance(true, 20, 1, null, false, 0, 103);
    expect(preserver.crossfadeMix).toBe(1);
    preserver.advance(true, 21, 1, null, false, 0, 103);
    expect(preserver.outgoingPosition).toBeNull();
  });

  it('selects the nearest reset crossing with the outgoing slope', () => {
    const preserver = new DurationPreserver(100);
    const zeroCrossings = [10, 12, 20];
    const samples = samplesWithSlopes({ 10: 'falling', 12: 'rising', 20: 'rising' });
    preserver.setEnabled(true, 10);

    expect(preserver.prepareCorrection(true, 20, 1, zeroCrossings, samples)).toEqual({
      outgoingPosition: 20,
      resetTarget: 12,
    });
  });

  it('keeps the correction pending when no slope-matched target is available', () => {
    const preserver = new DurationPreserver(100);
    const samples = samplesWithSlopes({ 10: 'falling', 12: 'rising', 20: 'rising' });
    preserver.setEnabled(true, 10);

    expect(preserver.prepareCorrection(true, 20, 1, [10, 20], samples)).toBeNull();
    expect(preserver.prepareCorrection(true, 12, 1, [10, 12, 20], samples)).toEqual({
      outgoingPosition: 12,
      resetTarget: 12,
    });
  });
});
