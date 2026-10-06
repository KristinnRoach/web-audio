import { describe, expect, it, vi } from 'vite-plus/test';
import type { SamplePlayer } from './SamplePlayer';
import type { SampleVoicePool } from './SampleVoicePool';
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

it('sends the loop-end period in seconds to voices after scale and root updates', async () => {
  vi.resetModules();
  vi.doUnmock('@/nodes/params');
  vi.stubGlobal('window', {});
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('AudioWorkletNode', class {});
  vi.stubGlobal(
    'GainNode',
    class {
      disconnect() {}
    },
  );
  const { SamplePlayer } = await import('./SamplePlayer');
  const context = Object.assign(new EventTarget(), {
    currentTime: 0,
    createConstantSource: () => ({
      offset: { setValueAtTime() {} },
      start() {},
      stop() {},
      disconnect() {},
    }),
  });
  const player = new SamplePlayer({ context: context as unknown as AudioContext });
  const sendToProcessor = vi.fn();
  player.voicePool = {
    applyToAllVoices: (apply) => apply({ sendToProcessor } as never),
    dispose() {},
  } as SampleVoicePool;

  try {
    player.setScale({
      rootNote: 'C',
      scale: [0],
      tuningOffset: 0,
      lowestOctave: 0,
      highestOctave: 5,
      normalize: { from: [0, 1], to: [0, 100] },
    });
    const macro = player.getMacro('loopEnd');
    const initialPeriod = macro.longestPeriodSeconds;
    expect(initialPeriod).toBeGreaterThan(0);
    expect(macro.longestPeriod).not.toBe(initialPeriod);
    expect(sendToProcessor).toHaveBeenLastCalledWith({
      type: 'setPitchPreservationThreshold',
      value: initialPeriod,
    });

    player.setRootNote('D');
    expect(macro.longestPeriodSeconds).not.toBe(initialPeriod);
    expect(sendToProcessor).toHaveBeenCalledTimes(2);
    expect(sendToProcessor).toHaveBeenLastCalledWith({
      type: 'setPitchPreservationThreshold',
      value: macro.longestPeriodSeconds,
    });
  } finally {
    player.dispose();
    vi.unstubAllGlobals();
  }
});

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
            { time: 0, value: 0, curve: 'exponential' },
            { time: 4, value: 0, curve: 'exponential' },
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

describe('SamplePlayer context watch', () => {
  it('warns and emits context:closed when its context closes, until disposed', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('GainNode', class {});
    vi.doMock('@/nodes/params', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      MacroParam: class {
        dispose() {}
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { SamplePlayer } = await import('./SamplePlayer');

    const context = Object.assign(new EventTarget(), { state: 'running' });
    const player = new SamplePlayer({ context: context as unknown as AudioContext });
    const closed = vi.fn();
    player.onMessage('context:closed', closed);

    context.dispatchEvent(new Event('statechange'));
    expect(warn).not.toHaveBeenCalled();

    context.state = 'closed';
    context.dispatchEvent(new Event('statechange'));
    expect(warn).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();

    player.dispose();
    context.dispatchEvent(new Event('statechange'));
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
    vi.doUnmock('@/nodes/params');
    vi.unstubAllGlobals();
  });

  it('disposes itself when init fails', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal(
      'GainNode',
      class {
        disconnect() {}
      },
    );
    vi.doMock('@/nodes/params', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      MacroParam: class {
        dispose() {}
      },
    }));
    vi.doMock('@/nodes/master/createInstrumentBus', () => ({
      createInstrumentBus: () => Promise.reject(new Error('boom')),
    }));
    const { SamplePlayer } = await import('./SamplePlayer');
    const { getNodeById } = await import('../../node-store');

    const context = Object.assign(new EventTarget(), { state: 'running' });
    const removeListener = vi.spyOn(context, 'removeEventListener');
    const player = new SamplePlayer({ context: context as unknown as AudioContext });
    expect(getNodeById(player.nodeId)).toBe(player);

    await expect(player.init()).rejects.toThrow('Failed to initialize SamplePlayer: boom');
    expect(getNodeById(player.nodeId)).toBeNull();
    expect(removeListener).toHaveBeenCalledWith('statechange', expect.any(Function));

    vi.doUnmock('@/nodes/params');
    vi.doUnmock('@/nodes/master/createInstrumentBus');
    vi.unstubAllGlobals();
  });
});
