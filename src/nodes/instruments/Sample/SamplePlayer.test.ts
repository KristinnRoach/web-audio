import { describe, expect, it, vi } from 'vite-plus/test';
import type { SamplePlayer } from './SamplePlayer';
import type { EnvelopeConfig } from './envelope-config';

const envConfig: EnvelopeConfig = {
  enabled: false,
  timeScale: 2,
  shape: {
    points: [
      { time: 0, value: 0, curve: 'linear' },
      { time: 1, value: 1, curve: 'exponential' },
    ],
    mode: { type: 'once' },
    sustainPoint: 1,
    releasePoint: 1,
  },
};

describe('SamplePlayer.applyParams', () => {
  it('applies only valid parameter values', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    const { SamplePlayer } = await import('./SamplePlayer');
    const setVolume = vi.fn();
    const setGlideTime = vi.fn();
    const setTempo = vi.fn();
    const setFeedbackPitchScale = vi.fn();
    const player = {
      setVolume,
      setGlideTime,
      setTempo,
      setFeedbackPitchScale,
    } as unknown as SamplePlayer;

    SamplePlayer.prototype.applyParams.call(player, {
      volume: 0.75,
      glide: 0.2,
      unknown: 1,
      tempo: 301,
      feedbackPitch: 0.3,
    } as never);

    expect(setVolume).toHaveBeenCalledWith(0.75);
    expect(setGlideTime).toHaveBeenCalledWith(0.2);
    expect(setTempo).not.toHaveBeenCalled();
    expect(setFeedbackPitchScale).not.toHaveBeenCalled();
  });
});

describe('SamplePlayer envelope config', () => {
  it('resets an envelope to defaults at the current sample duration', async () => {
    const { SamplePlayer } = await import('./SamplePlayer');
    const updateEnvelope = vi.fn();
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      updateEnvelope,
    }) as SamplePlayer;
    Object.defineProperty(player, 'sampleDuration', { value: 4 });

    player.resetEnvelope('pitch');

    expect(updateEnvelope).toHaveBeenCalledWith(
      'pitch',
      expect.objectContaining({
        enabled: false,
        shape: expect.objectContaining({
          points: [
            { time: 0, value: 1, curve: 'exponential' },
            { time: 4, value: 1, curve: 'exponential' },
          ],
        }),
      }),
    );
  });

  it('applies a detached snapshot to every voice and emits once', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    const { SamplePlayer } = await import('./SamplePlayer');
    const setEnvelopeConfig = vi.fn();
    const sendUpstreamMessage = vi.fn();
    const input: EnvelopeConfig = {
      ...envConfig,
      shape: {
        ...envConfig.shape,
        points: envConfig.shape.points.map((point) => ({ ...point })),
      },
    };
    const voices = [{ setEnvelopeConfig }, { setEnvelopeConfig }];
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      envelopeConfigs: new Map([['amp', envConfig]]),
      voicePool: {
        allVoices: voices,
        applyToAllVoices: (fn: (voice: (typeof voices)[number]) => void) => voices.forEach(fn),
      },
      sendUpstreamMessage,
    }) as SamplePlayer;

    player.updateEnvelope('amp', input);
    (input.shape.points[0] as { value: number }).value = 99;

    expect(setEnvelopeConfig).toHaveBeenCalledTimes(2);
    expect(player.getEnvelope('amp').shape.points[0].value).toBe(0);
    expect(sendUpstreamMessage).toHaveBeenCalledOnce();
    expect(sendUpstreamMessage).toHaveBeenCalledWith('envelope:changed', {
      id: 'amp',
      config: expect.objectContaining({ enabled: false }),
    });
  });

  it('rejects invalid snapshots before mutating voices', async () => {
    const { SamplePlayer } = await import('./SamplePlayer');
    const applyToAllVoices = vi.fn();
    const player = Object.assign(Object.create(SamplePlayer.prototype), {
      envelopeConfigs: new Map([['amp', envConfig]]),
      voicePool: {
        allVoices: [],
        applyToAllVoices,
      },
      sendUpstreamMessage: vi.fn(),
    }) as SamplePlayer;

    expect(() => player.updateEnvelope('amp', { ...envConfig, timeScale: 0 })).toThrowError(
      'Invalid envelope settings',
    );
    expect(() =>
      player.updateEnvelope('amp', {
        ...envConfig,
        playbackRateSync: 'yes' as unknown as boolean,
      }),
    ).toThrowError('Invalid envelope settings');
    expect(() =>
      player.updateEnvelope('amp', {
        ...envConfig,
        shape: { ...envConfig.shape, releasePoint: 99 },
      }),
    ).toThrowError('Invalid envelope settings');
    expect(applyToAllVoices).not.toHaveBeenCalled();
  });
});
