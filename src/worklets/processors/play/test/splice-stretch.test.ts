import { describe, expect, it } from 'vite-plus/test';
import { SpliceStretcher, MAX_DRIFT_MS } from '../splice-stretch.js';

function samplesWithSlopes(slopes: Record<number, 'rising' | 'falling'>) {
  const samples = new Float32Array(32);
  for (const [position, slope] of Object.entries(slopes)) {
    const index = Number(position);
    samples[index - 1] = slope === 'rising' ? -1 : 1;
    samples[index + 1] = slope === 'rising' ? 1 : -1;
  }
  return samples;
}

describe('SpliceStretcher', () => {
  it.each([0, 0.1, 2, 5, 12.5])('uses the configured %s ms overlap duration', (milliseconds) => {
    const stretcher = new SpliceStretcher(1000);
    const samples = new Float32Array(200);
    samples[21] = samples[101] = 1;
    stretcher.crossfadeDurationMs = milliseconds;
    stretcher.setEnabled(true, 20);
    stretcher.prepareCorrection(true, 100, 1, [20, 100], samples);
    let frames = 0;
    let position = 100;
    while (stretcher.outgoingPosition !== null && frames < 200) {
      position = stretcher.advance(true, position, 1, frames === 0 ? 20 : null, false, 0, 200);
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
    const stretcher = new SpliceStretcher(1000);
    const samples = new Float32Array(length);
    samples[start + 1] = samples[playhead + 1] = 1;
    stretcher.crossfadeDurationMs = 10 * maxDrift;
    stretcher.setEnabled(true, start);
    stretcher.prepareCorrection(true, playhead, rate, [start, playhead], samples);
    let frames = 0;
    let position = playhead;
    while (stretcher.outgoingPosition !== null && frames < length) {
      position = stretcher.advance(
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
    const stretcher = new SpliceStretcher(1000);
    const samples = new Float32Array(200);
    samples[21] = samples[101] = 1;
    stretcher.setEnabled(true, 20);
    stretcher.crossfadeDurationMs = 5;

    const correction = stretcher.prepareCorrection(true, 100, rate, [20, 100], samples);
    expect(correction?.resetTarget).toBe(20);
    expect(stretcher.outgoingPosition).toBe(100);
    expect(stretcher.crossfadeMix).toBe(0);
    let position = stretcher.advance(true, 100, rate, 20, false, 0, 200);
    for (let i = 1; i < 5; i++) {
      expect(stretcher.outgoingPosition).toBe(100 + i * rate);
      expect(stretcher.crossfadeMix).toBeGreaterThan(0);
      expect(stretcher.crossfadeMix).toBeLessThanOrEqual(1);
      // No competing correction while the fade is active.
      expect(stretcher.prepareCorrection(true, position, rate, [20, 100], samples)).toBeNull();
      position = stretcher.advance(true, position, rate, null, false, 0, 200);
    }
    expect(stretcher.outgoingPosition).toBeNull();
    expect(position).toBe(20 + 4 * rate);
    expect(stretcher.timelinePosition).toBe(20 + 5 * rate);
  });

  it.each(['toggle', 'reset', 'inactive', 'direction', 'boundary'])(
    'clears an overlap on %s',
    (reason) => {
      const stretcher = new SpliceStretcher(1000);
      const samples = new Float32Array(200);
      samples[21] = samples[101] = 1;
      stretcher.setEnabled(true, 20);
      stretcher.crossfadeDurationMs = 5;
      stretcher.prepareCorrection(true, 100, 1, [20, 100], samples);
      expect(stretcher.outgoingPosition).toBe(100);
      if (reason === 'toggle') stretcher.crossfadeDurationMs = 0;
      if (reason === 'reset') stretcher.reset();
      if (reason === 'inactive') stretcher.prepareCorrection(false, 20, 1, [], samples);
      if (reason === 'direction') stretcher.prepareCorrection(true, 20, -1, [], samples);
      if (reason === 'boundary') stretcher.prepareCorrection(true, 20, 1, [], samples, 0, 100);
      expect(stretcher.outgoingPosition).toBeNull();
    },
  );

  it('shortens the fade at an edge', () => {
    const stretcher = new SpliceStretcher(1000);
    const samples = new Float32Array(103);
    samples[21] = samples[101] = 1;
    stretcher.setEnabled(true, 20);
    stretcher.crossfadeDurationMs = 5;
    stretcher.prepareCorrection(true, 100, 1, [20, 100], samples);
    stretcher.advance(true, 100, 1, 20, false, 0, 103);
    expect(stretcher.crossfadeMix).toBe(0.5);
    stretcher.advance(true, 20, 1, null, false, 0, 103);
    expect(stretcher.crossfadeMix).toBe(1);
    stretcher.advance(true, 21, 1, null, false, 0, 103);
    expect(stretcher.outgoingPosition).toBeNull();
  });

  it('selects the nearest reset crossing with the outgoing slope', () => {
    const stretcher = new SpliceStretcher(100);
    const zeroCrossings = [10, 12, 20];
    const samples = samplesWithSlopes({ 10: 'falling', 12: 'rising', 20: 'rising' });
    stretcher.setEnabled(true, 10);

    expect(stretcher.prepareCorrection(true, 20, 1, zeroCrossings, samples)).toEqual({
      outgoingPosition: 20,
      resetTarget: 12,
    });
  });

  it('keeps the correction pending when no slope-matched target is available', () => {
    const stretcher = new SpliceStretcher(100);
    const samples = samplesWithSlopes({ 10: 'falling', 12: 'rising', 20: 'rising' });
    stretcher.setEnabled(true, 10);

    expect(stretcher.prepareCorrection(true, 20, 1, [10, 20], samples)).toBeNull();
    expect(stretcher.prepareCorrection(true, 12, 1, [10, 12, 20], samples)).toEqual({
      outgoingPosition: 12,
      resetTarget: 12,
    });
  });
});
