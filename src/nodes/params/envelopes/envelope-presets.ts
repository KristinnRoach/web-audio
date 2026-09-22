import type { EnvelopeConfig } from './envelope-config';

function durationOf(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError('Envelope duration must be greater than zero');
  }
  return duration;
}

export const envelopePresets = {
  amplitude(durationSeconds = 1): EnvelopeConfig {
    const duration = durationOf(durationSeconds);
    return {
      enabled: true,
      timeScale: 1,
      envelope: {
        mode: { type: 'sustain', at: 3 },
        points: [
          { time: 0, value: 0, curve: 'exponential' },
          {
            time: Math.min(0.005, 0.1 * duration),
            value: 1,
            curve: 'exponential',
          },
          { time: 0.25 * duration, value: 0.75, curve: 'exponential' },
          { time: 0.9 * duration, value: 0.5, curve: 'exponential' },
          { time: duration, value: 0, curve: 'exponential' },
        ],
        release: 3,
      },
    };
  },

  pitch(durationSeconds = 1): EnvelopeConfig {
    const duration = durationOf(durationSeconds);
    return {
      enabled: false,
      timeScale: 1,
      envelope: {
        mode: { type: 'once' },
        points: [
          { time: 0, value: 1, curve: 'exponential' },
          { time: duration, value: 1, curve: 'exponential' },
        ],
        release: 0,
      },
    };
  },

  filter(durationSeconds = 1): EnvelopeConfig {
    const duration = durationOf(durationSeconds);
    return {
      enabled: false,
      timeScale: 1,
      envelope: {
        mode: { type: 'once' },
        points: [
          { time: 0, value: 0, curve: 'exponential' },
          { time: 0.02 * duration, value: 1, curve: 'exponential' },
          { time: 0.3 * duration, value: 0.2, curve: 'exponential' },
          { time: duration, value: 0, curve: 'exponential' },
        ],
        release: 2,
      },
    };
  },
};
