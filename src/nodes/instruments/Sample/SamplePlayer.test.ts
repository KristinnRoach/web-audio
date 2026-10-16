import { initTestPlayer } from './test/initTestPlayer';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { SamplePlayer } from './SamplePlayer';
import type { SampleVoicePool } from './SampleVoicePool';
import type { EnvelopeConfig } from './envelope-config';
import { NOTE_PERIODS } from '../../../utils/music-theory/constants';

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
      connect() {}
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
      connect() {},
      disconnect() {},
    }),
  });
  const player = new SamplePlayer({ context: context as unknown as AudioContext });
  const sendToProcessor = vi.fn();
  await initTestPlayer(player, {
    applyToAllVoices: (apply) =>
      apply({ sendToProcessor, getParam: () => null, setParam() {} } as never),
    dispose() {},
  });

  try {
    player.setScale({
      rootNote: 'C',
      scale: [0],
      tuningOffset: 0,
      lowestOctave: 0,
      highestOctave: 5,
    });
    // Root in octaves 0–5, in seconds, sorted shortest first (C5 ... C0).
    expect(sendToProcessor).toHaveBeenLastCalledWith({
      type: 'setLoopSnapPeriods',
      value: [60, 48, 36, 24, 12, 0].map((i) => NOTE_PERIODS[i]),
    });

    player.setRootNote('D');
    expect(sendToProcessor).toHaveBeenCalledTimes(2);
    expect(sendToProcessor).toHaveBeenLastCalledWith({
      type: 'setLoopSnapPeriods',
      value: [62, 50, 38, 26, 14, 2].map((i) => NOTE_PERIODS[i]), // D5 ... D0
    });

    const valid = {
      rootNote: 'C',
      scale: [0],
      tuningOffset: 0,
      lowestOctave: 0,
      highestOctave: 5,
    } as const;
    expect(() => player.setScale({ ...valid, scale: [12] })).toThrow(RangeError);
    expect(() => player.setScale({ ...valid, scale: [0.5] })).toThrow(RangeError);
    expect(() => player.setScale({ ...valid, highestOctave: 10, scale: [0] })).toThrow(RangeError);
    expect(() => player.setScale({ ...valid, scale: [] })).toThrow(RangeError);
    expect(() => player.setScale({ ...valid, lowestOctave: 0.5, scale: [0] })).toThrow(RangeError);
    expect(() => player.setScale({ ...valid, lowestOctave: 6, scale: [0] })).toThrow(RangeError);
    expect(() => player.setScale({ ...valid, tuningOffset: NaN, scale: [0] })).toThrow(RangeError);
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
    const changed = vi.fn();
    const input: EnvelopeConfig = {
      ...envConfig,
      shape: {
        ...envConfig.shape,
        points: envConfig.shape.points.map((point) => ({ ...point })),
      },
    };
    const voices = [0, 1].map(() => ({ setEnvelopeConfig, getParam: () => null, setParam() {} }));
    vi.stubGlobal(
      'GainNode',
      class {
        connect() {}
        disconnect() {}
      },
    );
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    await initTestPlayer(player, {
      allVoices: voices,
      applyToAllVoices: (fn: (voice: (typeof voices)[number]) => void) => voices.forEach(fn),
      allNotesOff() {},
      dispose() {},
    } as unknown as Partial<SampleVoicePool>);
    player.onMessage('envelope:changed', changed);

    try {
      player.updateEnvelope('amp', input);
      (input.shape.points[0] as { value: number }).value = 99;

      expect(setEnvelopeConfig).toHaveBeenCalledTimes(2);
      expect(player.getEnvelope('amp').shape.points[0].value).toBe(0);
      expect(changed).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledWith({
        type: 'envelope:changed',
        senderId: player.nodeId,
        id: 'amp',
        config: expect.objectContaining({ enabled: false }),
      });
    } finally {
      player.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('rejects invalid snapshots before mutating voices', async () => {
    const { SamplePlayer } = await import('./SamplePlayer');
    const applyToAllVoices = vi.fn();
    vi.stubGlobal(
      'GainNode',
      class {
        connect() {}
        disconnect() {}
      },
    );
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    await initTestPlayer(player, { applyToAllVoices });
    applyToAllVoices.mockClear();

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
    player.dispose();
    vi.unstubAllGlobals();
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
        connect() {}
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
