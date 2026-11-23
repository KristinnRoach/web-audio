import { initTestPlayer, getTestLFOs } from './test/initTestPlayer';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SamplePlayer } from './SamplePlayer';
import type { AudioDestination, ILibAudioNode } from '../../LibAudioNode';
import type { EnvelopeConfig } from './envelope-config';
import { createDefaultSampleEnvelopeConfig } from './sample-envelope-policy';
import { NOTE_PERIODS } from '../../../utils/music-theory/constants';
import { VOICE_SUM_GAIN } from '../../master/defaults';

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

it('sends loop quantize periods on quantization updates but not on transpose', async () => {
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
  expect(() => player.setLoopEnabled(false)).not.toThrow();
  expect(player.getLoopPitchPeriods()).toEqual(
    [60, 48, 36, 24, 12].map((i) => expect.closeTo(NOTE_PERIODS[i], 6)),
  );
  const { VoiceEffects } = await import('./VoiceEffects');
  const setPitchOffset = vi.spyOn(VoiceEffects.prototype, 'setPitchOffset');
  const setBusFeedbackPitch = vi.fn();
  player.setLoopPitchQuantization({ scale: [2], lowestOctave: 0, highestOctave: 5 });

  const { report, ofType } = await initTestPlayer(player, {
    bus: { getFeedback: () => ({ setPitch: setBusFeedbackPitch }) } as never,
  });
  const periodsPosted = () => ofType('voice:setLoopQuantizePeriods');

  const initialPeriods = [62, 50, 38, 26, 14, 2].map((i) => expect.closeTo(NOTE_PERIODS[i], 6));
  expect(player.getLoopPitchPeriods()).toEqual(initialPeriods);
  // Once for the whole processor, not once per voice.
  expect(periodsPosted()).toEqual([
    { type: 'voice:setLoopQuantizePeriods', value: initialPeriods },
  ]);

  try {
    player.setLoopPitchQuantization({
      scale: [0],
      lowestOctave: 0,
      highestOctave: 5,
    });
    // Root in octaves 0–5, in seconds, sorted shortest first (C5 ... C0).
    expect(periodsPosted().at(-1)).toEqual({
      type: 'voice:setLoopQuantizePeriods',
      value: [60, 48, 36, 24, 12, 0].map((i) => expect.closeTo(NOTE_PERIODS[i], 6)),
    });

    const periods = player.getLoopPitchPeriods();
    expect(periods).toEqual(periodsPosted().at(-1).value);
    periods.fill(0);
    expect(player.getLoopPitchPeriods()[0]).toBeGreaterThan(0);

    // The transpose carries quantized loops; rebuilding the periods too would shift them twice.
    player.transpose(2);
    expect(periodsPosted()).toHaveLength(2);
    expect(setPitchOffset).toHaveBeenLastCalledWith(2, null);
    expect(ofType('pool:setPitchOffset').at(-1)).toEqual({ type: 'pool:setPitchOffset', value: 2 });
    expect(player.transposedBySemitones).toBe(2);

    // Fine tune sums with transpose instead of replacing it.
    player.fineTune(-50);
    expect(setPitchOffset).toHaveBeenLastCalledWith(1.5, null);
    player.transpose(-1);
    expect(setPitchOffset).toHaveBeenLastCalledWith(-1.5, null);

    // Bus feedback retunes from the last played note; before any note it has nothing to follow.
    expect(setBusFeedbackPitch).not.toHaveBeenCalled();
    player.play(60);
    player.transpose(2);
    expect(setBusFeedbackPitch.mock.lastCall?.[0]).toBe(61.5);
    // A legato fallback on release retunes the bus feedback to the earlier held note.
    player.syncLFOsToNoteFreq('gain-lfo', true);
    player.syncLFOsToNoteFreq('pitch-lfo', true);
    report({ type: 'voice:started', voice: 0, triggerId: 1, midiNote: 60, timestamp: 0 });
    player.release(60, 1);
    report({
      type: 'voice:retuned',
      voice: 0,
      midiNote: 57,
      glideTime: 0.1,
      timestamp: 1,
      fallback: true,
    });
    expect(setBusFeedbackPitch).toHaveBeenLastCalledWith(58.5, 0, 1, 0.1);
    for (const lfo of getTestLFOs().slice(-2)) {
      expect(lfo.setMusicalNote).toHaveBeenLastCalledWith(58.5, { divisor: 4, timestamp: 1 });
    }

    player.setLoopPitchQuantization({
      scale: [2],
      lowestOctave: 0,
      highestOctave: 5,
    });
    expect(periodsPosted().at(-1)).toEqual({
      type: 'voice:setLoopQuantizePeriods',
      value: [62, 50, 38, 26, 14, 2].map((i) => expect.closeTo(NOTE_PERIODS[i], 6)), // D5 ... D0
    });

    const valid = {
      scale: [0],
      lowestOctave: 0,
      highestOctave: 5,
    } as const;
    expect(() => player.setLoopPitchQuantization({ ...valid, scale: [NaN] })).toThrow(RangeError);
    expect(() => player.setLoopPitchQuantization({ ...valid, scale: [Infinity] })).toThrow(
      RangeError,
    );
    expect(() =>
      player.setLoopPitchQuantization({ ...valid, highestOctave: 10, scale: [0] }),
    ).toThrow(RangeError);
    expect(() => player.setLoopPitchQuantization({ ...valid, scale: [] })).toThrow(RangeError);
    expect(() =>
      player.setLoopPitchQuantization({ ...valid, lowestOctave: 0.5, scale: [0] }),
    ).toThrow(RangeError);
    expect(() =>
      player.setLoopPitchQuantization({ ...valid, lowestOctave: 6, scale: [0] }),
    ).toThrow(RangeError);
  } finally {
    player.dispose();
    expect(() => player.setLoopEnabled(false)).not.toThrow();
    setPitchOffset.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('replays settings made before init to the processor and voices', async () => {
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
  const { VoiceEffects } = await import('./VoiceEffects');
  const setPitchOffset = vi.spyOn(VoiceEffects.prototype, 'setPitchOffset');
  const context = Object.assign(new EventTarget(), { currentTime: 0 });
  const player = new SamplePlayer({ context: context as unknown as AudioContext, polyphony: 2 });

  try {
    player.transpose(2).fineTune(-50).setLoopEnabled(true).setKeytrackLoopAmount(0.25);
    player.setTimestretchMode('period').setStartFromLoop(true);
    const { ofType } = await initTestPlayer(player);

    expect(ofType('voice:setLoopEnabled')).toEqual([{ type: 'voice:setLoopEnabled', value: true }]);
    expect(ofType('voice:setStartFromLoop')).toEqual([
      { type: 'voice:setStartFromLoop', value: true },
    ]);
    expect(ofType('voice:setKeytrackLoopAmount')).toEqual([
      { type: 'voice:setKeytrackLoopAmount', value: 0.25 },
    ]);
    expect(ofType('voice:setTimestretchMode')).toEqual([
      { type: 'voice:setTimestretchMode', value: 'period' },
    ]);
    expect(setPitchOffset.mock.calls).toEqual([
      [1.5, null],
      [1.5, null],
    ]);
    expect(ofType('pool:setPitchOffset')).toEqual([{ type: 'pool:setPitchOffset', value: 1.5 }]);
  } finally {
    player.dispose();
    setPitchOffset.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('keeps LFO routing and parameter mappings behind player controls', async () => {
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
  const context = Object.assign(new EventTarget(), { currentTime: 0 });
  const player = new SamplePlayer({ context: context as unknown as AudioContext });

  try {
    const { worklet } = await initTestPlayer(player);
    const [gainLFO, pitchLFO] = getTestLFOs().slice(-2);
    // Every voice reads the processor's one detune param.
    expect(pitchLFO.connect).toHaveBeenCalledExactlyOnceWith(worklet.parameters.get('detune'));

    player.applyParams({ gainLFORate: 0.5, gainLFODepth: 0.75, pitchLFORate: 0.25 });
    expect(gainLFO.setFrequency).toHaveBeenLastCalledWith(50.1);
    // Half the depth, scaled to the bus input's headroom gain.
    expect(gainLFO.setDepth).toHaveBeenLastCalledWith((VOICE_SUM_GAIN * 0.75) / 2);
    const inputGain = player.input.gain.setValueAtTime as ReturnType<typeof vi.fn>;
    expect(inputGain).toHaveBeenLastCalledWith(VOICE_SUM_GAIN * (1 - 0.75 / 2), player.now);
    player.applyParams({ gainLFODepth: 0 });
    expect(inputGain).toHaveBeenLastCalledWith(VOICE_SUM_GAIN, player.now);
    expect(pitchLFO.setFrequency).toHaveBeenLastCalledWith(25.1);

    player.applyParams({ pitchLFODepth: 1 });
    expect(pitchLFO.setDepth).toHaveBeenLastCalledWith(200);
    player.applyParams({ pitchLFODepth: 0 });
    expect(pitchLFO.setDepth).toHaveBeenLastCalledWith(0);
  } finally {
    player.dispose();
    vi.unstubAllGlobals();
  }
});

it('routes library nodes to players, input wrappers, and native nodes', async () => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('AudioWorkletNode', class {});
  vi.stubGlobal(
    'GainNode',
    class {
      connect = vi.fn();
      disconnect = vi.fn();
    },
  );
  const { SamplePlayer } = await import('./SamplePlayer');
  const { LibAudioNode } = await import('../../LibAudioNode');
  const context = Object.assign(new EventTarget(), { currentTime: 0 }) as AudioContext;
  const connect = vi.fn();
  const disconnect = vi.fn();
  const source: ILibAudioNode = new LibAudioNode(
    { connect, disconnect, context } as unknown as AudioNode,
    context,
    'GainNode',
  );
  const player = new SamplePlayer({ context });

  try {
    await initTestPlayer(player);
    const input = {} as AudioNode;
    const playerConnect = vi.spyOn(player.output, 'connect');
    const playerDisconnect = vi.spyOn(player.output, 'disconnect');
    const destinations: AudioDestination[] = [player, { input }, input];
    for (const destination of destinations) {
      const target = 'input' in destination ? destination.input : destination;
      source.connect(destination);
      expect(connect).toHaveBeenLastCalledWith(target);
      expect(source.connections.outgoing).toEqual(destination === player ? [player.nodeId] : []);
      source.disconnect(destination);
      expect(disconnect).toHaveBeenLastCalledWith(target);
      expect(source.connections.outgoing).toEqual([]);
    }
    for (const destination of [source, { input }, input]) {
      const target = 'input' in destination ? destination.input : destination;
      player.connect(destination);
      expect(playerConnect).toHaveBeenLastCalledWith(target);
      player.disconnect(destination);
      expect(playerDisconnect).toHaveBeenLastCalledWith(target);
    }
  } finally {
    source.dispose();
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
    const setFeedbackPitchScale = vi.fn();
    const setTrimStart = vi.fn();
    const setTrimEnd = vi.fn();
    const player = {
      setVolume,
      setGlideTime,
      setFeedbackPitchScale,
      setTrimStart,
      setTrimEnd,
      sampleDuration: 2,
    } as unknown as SamplePlayer;

    SamplePlayer.prototype.applyParams.call(player, {
      volume: 0.75,
      glide: 0.2,
      unknown: 1,
      feedbackPitch: 0.3,
      trimStart: 0.1,
      trimEnd: 0.9,
    } as never);

    expect(setVolume).toHaveBeenCalledWith(0.75);
    expect(setGlideTime).toHaveBeenCalledWith(0.2);
    expect(setFeedbackPitchScale).not.toHaveBeenCalled();
    expect(setTrimStart).toHaveBeenCalledWith(0.2);
    expect(setTrimEnd).toHaveBeenCalledWith(1.8);
  });
});

describe('SamplePlayer envelope config', () => {
  it('scales duration through the normal update path without storing a second duration', async () => {
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
    const changed = vi.fn();
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    const { posted, ofType } = await initTestPlayer(player);
    const envelopesPosted = () => ofType('voice:setEnvelope');
    player.onMessage('envelope:changed', changed);
    const shape = {
      ...envConfig.shape,
      mode: { type: 'sustain' } as const,
      points: [
        { time: 5, value: 0, curve: 'linear' } as const,
        { time: 6, value: 1, curve: 'exponential' } as const,
        { time: 9, value: 0 } as const,
      ],
    };

    try {
      expect(() => player.updateEnvelope('amp', { durationRatio: 1 })).toThrow(RangeError);
      // A supplied shape is scaled in the same update, before playback speed is applied.
      player.updateEnvelope('amp', { ...envConfig, shape, duration: 2 });
      const config = player.getEnvelope('amp');
      expect(config.shape).toEqual({
        ...shape,
        points: shape.points.map((point, i) => ({ ...point, time: [5, 5.5, 7][i] })),
      });
      expect(shape.points.map((point) => point.time)).toEqual([5, 6, 9]);
      expect(player.getEnvelopeDuration('amp')).toBe(2);
      expect(config.timeScale).toBe(2);
      expect(config).not.toHaveProperty('duration');
      expect(envelopesPosted()).toEqual([
        { type: 'voice:setEnvelope', target: 'gain', value: null },
      ]);
      expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ config }));

      // A duration-only update scales the stored shape and preserves its other settings.
      player.updateEnvelope('amp', { duration: 8 });
      const resized = player.getEnvelope('amp');
      expect(player.getEnvelopeDuration('amp')).toBe(8);
      expect(resized).toMatchObject({ enabled: false, timeScale: 2 });

      posted.length = 0;
      changed.mockClear();
      for (const duration of [0, -1, NaN, Infinity]) {
        expect(() => player.updateEnvelope('amp', { duration })).toThrow(RangeError);
      }
      expect(player.getEnvelope('amp')).toEqual(resized);
      expect(envelopesPosted()).toEqual([]);
      expect(changed).not.toHaveBeenCalled();

      const sampleDuration = 10007 / 48000;
      const durationGetter = vi
        .spyOn(player, 'sampleDuration', 'get')
        .mockReturnValue(sampleDuration);
      try {
        player.updateEnvelope('amp', {
          shape: {
            ...envConfig.shape,
            points: [
              { time: 0, value: 0 },
              { time: 0.3, value: 1 },
            ],
          },
          durationRatio: 1,
        });
        expect(player.getEnvelopeDuration('amp')).toBe(sampleDuration);
        expect(player.getEnvelope('amp')).not.toHaveProperty('durationRatio');
        player.updateEnvelope('amp', { durationRatio: 2 });
        expect(player.getEnvelopeDuration('amp')).toBe(sampleDuration * 2);
        player.updateEnvelope('amp', { durationRatio: 0.5 });
        expect(player.getEnvelopeDuration('amp')).toBe(sampleDuration / 2);

        const before = player.getEnvelope('amp');
        changed.mockClear();
        posted.length = 0;
        for (const durationRatio of [0, -1, NaN, Infinity, -Infinity]) {
          expect(() => player.updateEnvelope('amp', { durationRatio })).toThrow(RangeError);
        }
        expect(() => player.updateEnvelope('amp', { duration: 1, durationRatio: 1 })).toThrow(
          TypeError,
        );
        expect(player.getEnvelope('amp')).toEqual(before);
        expect(changed).not.toHaveBeenCalled();
        expect(envelopesPosted()).toEqual([]);
      } finally {
        durationGetter.mockRestore();
      }
    } finally {
      player.dispose();
      vi.unstubAllGlobals();
    }
  });

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
      createDefaultSampleEnvelopeConfig('pitch', 4),
    );
  });

  it('posts a detached snapshot once for every voice and emits once', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    const { SamplePlayer } = await import('./SamplePlayer');
    const changed = vi.fn();
    const input: EnvelopeConfig = {
      ...envConfig,
      enabled: true,
      shape: {
        ...envConfig.shape,
        points: envConfig.shape.points.map((point) => ({ ...point })),
      },
    };
    vi.stubGlobal(
      'GainNode',
      class {
        connect() {}
        disconnect() {}
      },
    );
    const player = new SamplePlayer({
      context: new EventTarget() as AudioContext,
      polyphony: 2,
    });
    const { ofType } = await initTestPlayer(player);
    player.onMessage('envelope:changed', changed);

    try {
      player.updateEnvelope('amp', input);
      changed.mockClear();
      player.updateEnvelope('amp', { depth: 0.5 });
      (input.shape.points[0] as { value: number }).value = 99;

      // One untagged message per update reaches both voices.
      const envelopes = ofType('voice:setEnvelope');
      expect(envelopes).toHaveLength(2);
      envelopes.forEach((message) => expect(message).not.toHaveProperty('voice'));
      expect(player.getEnvelope('amp').shape.points[0].value).toBe(0);
      expect(player.getEnvelope('amp').depth).toBe(0.5);
      expect(envelopes[1].value).toMatchObject({ depth: 0.5 });
      expect(changed).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledWith({
        type: 'envelope:changed',
        senderId: player.nodeId,
        id: 'amp',
        config: expect.objectContaining({ enabled: true, depth: 0.5 }),
      });
      player.updateEnvelope('amp', { depth: -0.25 });
      expect(player.getEnvelope('amp')).toMatchObject({ depth: -0.25 });
      player.updateEnvelope('amp', { depth: 0.75 });
      expect(player.getEnvelope('amp')).toMatchObject({ depth: 0.75 });
      expect(player.getEnvelope('amp')).not.toHaveProperty('amount');
      expect(player.getEnvelope('amp').depth).toBe(0.75);
    } finally {
      player.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('rejects invalid snapshots before mutating voices', async () => {
    const { SamplePlayer } = await import('./SamplePlayer');
    vi.stubGlobal(
      'GainNode',
      class {
        connect() {}
        disconnect() {}
      },
    );
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    const { posted } = await initTestPlayer(player);
    posted.length = 0;

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
    expect(posted).toEqual([]);
    player.dispose();
    vi.unstubAllGlobals();
  });
});

describe('SamplePlayer context watch', () => {
  it('waits for each flush acknowledgement and rejects pending flushes on disposal', async () => {
    vi.stubGlobal(
      'GainNode',
      class {
        connect() {}
        disconnect() {}
      },
    );
    const { SamplePlayer } = await import('./SamplePlayer');
    const player = new SamplePlayer({ context: new EventTarget() as AudioContext });
    try {
      await expect(player.flushMessages()).rejects.toThrow('SamplePlayer is not initialized');
      const { report, ofType } = await initTestPlayer(player);
      const firstDone = vi.fn();
      const secondDone = vi.fn();
      const first = player.flushMessages().then(firstDone);
      const second = player.flushMessages().then(secondDone);
      const [a, b] = ofType('flush');

      report({ type: 'flushed', id: b.id });
      await second;
      expect(secondDone).toHaveBeenCalledOnce();
      expect(firstDone).not.toHaveBeenCalled();
      report({ type: 'flushed', id: a.id });
      await first;
      expect(firstDone).toHaveBeenCalledOnce();

      const pending = expect(player.flushMessages()).rejects.toThrow('SamplePlayer is disposed');
      player.dispose();
      await pending;
      await expect(player.flushMessages()).rejects.toThrow('SamplePlayer is disposed');
    } finally {
      player.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('distinguishes disposal from initialization and ignores late note calls', async () => {
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
    const { getNodeById } = await import('../../node-store');
    const player = new SamplePlayer({
      context: new EventTarget() as AudioContext,
      polyphony: 2,
    });
    expect(player.initialized).toBe(false);
    expect(player.disposed).toBe(false);
    const releaseAll = vi.fn();
    const { worklet } = await initTestPlayer(player, { bus: { releaseAll } });
    const close = vi.spyOn(worklet.port, 'close');
    expect(player.initialized).toBe(true);
    expect(player.disposed).toBe(false);

    player.dispose();
    player.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(getNodeById(player.nodeId)).toBeNull();
    expect(player.initialized).toBe(false);
    expect(player.disposed).toBe(true);
    expect(player.play(60)).toBeNull();
    expect(player.release(60)).toBe(player);
    expect(player.releaseAll()).toBe(player);
    expect(releaseAll).toHaveBeenCalledOnce();
    await expect(player.init()).rejects.toThrow('SamplePlayer is disposed');
    await expect(player.cropSample()).rejects.toThrow('SamplePlayer is disposed');
    await expect(player.commitPitch()).rejects.toThrow('SamplePlayer is disposed');
    vi.unstubAllGlobals();
  });

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

it.each([null, 'linear', 'sinc'] as const)(
  'preserves interpolation selected before initialization: %s',
  async (mode) => {
    vi.resetModules();
    vi.doUnmock('@/nodes/params');
    vi.doUnmock('@/nodes/master/createInstrumentBus');
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
    const context = Object.assign(new EventTarget(), { currentTime: 0 });
    const player = new SamplePlayer({ context: context as unknown as AudioContext });
    try {
      expect(() => player.setInterpolation('sync' as never)).toThrow(RangeError);
      if (mode !== null) {
        player.setInterpolation('hermite');
        expect(player.setInterpolation(mode)).toBe(player);
      }
      const { ofType } = await initTestPlayer(player);
      const modes = () => ofType('voice:setInterpolation').map((message) => message.value);
      expect(modes()).toEqual(mode === null ? [] : [mode]);
      player.setInterpolation('linear');
      expect(modes().at(-1)).toBe('linear');
    } finally {
      player.dispose();
      vi.unstubAllGlobals();
    }
  },
);

it('mirrors voice reports and passes on only those about the note each voice plays', async () => {
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
  const context = Object.assign(new EventTarget(), { currentTime: 0 });
  const player = new SamplePlayer({ context: context as unknown as AudioContext, polyphony: 2 });
  const { report } = await initTestPlayer(player);
  const upstream: any[] = [];
  for (const type of ['voice:started', 'voice:releasing', 'voice:stopped', 'loop:range']) {
    player.onMessage(type, (message: object) => upstream.push(message));
  }
  const started = { type: 'voice:started', velocity: 100, timestamp: 0, glideTime: 0 };
  const range = { type: 'loop:range', loopStart: 0, loopEnd: 1 };

  try {
    report({ ...started, voice: 0, triggerId: 1, midiNote: 60, glideFromNote: null });
    report({ ...range, voice: 0, triggerId: 0 }); // an earlier note's
    report({ ...range, voice: 0, triggerId: 1, idle: true }); // the next note's
    report({ ...range, voice: 0, triggerId: 1 });
    report({ ...range, voice: 1, triggerId: 1 }); // a free voice
    report({ type: 'voice:retuned', voice: 0, midiNote: 64, timestamp: 0, glideTime: 0 });
    // Stolen for a new note: the old one stops without a report of its own.
    report({ ...started, voice: 0, triggerId: 2, midiNote: 67, glideFromNote: null });
    report({ type: 'voice:ended', voice: 0, triggerId: 1 });
    report({ type: 'voice:releasing', voice: 0 });
    report({ type: 'voice:ended', voice: 0, triggerId: 2 });
    report({ type: 'voice:releasing', voice: 0 });
    report({ ...started, voice: 1, triggerId: 3, midiNote: 72, glideFromNote: null });
    player.dispose(); // stops what still sounds

    const voiceId = upstream[0].voiceId;
    expect(voiceId).toMatch(/^\d+-sample-voice$/);
    expect(upstream.slice(0, 2)).toEqual([
      { ...started, senderId: voiceId, voiceId, midiNote: 60 },
      { type: 'loop:range', senderId: voiceId, voiceId, midiNote: 60, loopStart: 0, loopEnd: 1 },
    ]);
    expect(upstream.map(({ type, midiNote }) => [type, midiNote])).toEqual([
      ['voice:started', 60],
      ['loop:range', 60],
      ['voice:stopped', 64],
      ['voice:started', 67],
      ['voice:releasing', 67],
      ['voice:stopped', 67],
      ['voice:started', 72],
      ['voice:stopped', 72],
    ]);
    expect(upstream.at(-1).voiceId).not.toBe(voiceId);
  } finally {
    player.dispose();
    vi.unstubAllGlobals();
  }
});

describe('SamplePlayer with the real audio-thread voice pool', () => {
  let player: SamplePlayer | undefined;

  afterEach(() => {
    player?.dispose();
    player = undefined;
    vi.unstubAllGlobals();
  });

  /** The port reaches a real VoicePool at once, so a test reads its decision on the next line. */
  async function setup(beforeInit?: (player: SamplePlayer) => void) {
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
    const { PoolVoice, VoicePool } =
      await import('../../../worklets/processors/play/engine/voice-pool.js');
    const context = Object.assign(new EventTarget(), {
      currentTime: 0,
      sampleRate: 48000,
    }) as AudioContext;
    const pool = new VoicePool();
    const voices = [0, 1, 2].map((index) => {
      const engine = { loopEnabled: true, start() {}, stop() {}, release() {}, setNoteRate() {} };
      const voice = new PoolVoice(engine, (message: object) =>
        test.report({ ...message, voice: index }),
      );
      pool.addVoice(voice);
      return voice;
    });
    const noteOff = vi.fn();
    const releaseAll = vi.fn();
    const setPitch = vi.fn();
    player = new SamplePlayer({ context, polyphony: voices.length });
    beforeInit?.(player);
    const test = await initTestPlayer(player, {
      bus: { noteOff, releaseAll, getFeedback: () => ({ setPitch }) } as never,
      onPost: (message) => {
        if (message.type === 'pool:setLegato') pool.allocator.legato = message.value;
        else if (message.type === 'pool:setPitchOffset') pool.setPitchOffset(message.value, 0);
        else if (message.type === 'pool:setPitchEnabled') pool.setPitchEnabled(message.value, 0);
        else if (message.type.startsWith('pool:')) {
          pool.schedule(message);
          pool.advance(Infinity);
        } else if (message.type === 'voice:setBuffer') {
          voices.forEach((_, voice) => test.report({ type: 'voice:loaded', voice }));
        }
      },
    });
    const data = new Float32Array([0.5]);
    await player.loadAudio(
      {
        length: 1,
        duration: 1,
        numberOfChannels: 1,
        sampleRate: 48000,
        getChannelData: () => data,
        copyFromChannel: (destination: Float32Array) => destination.set(data),
      } as unknown as AudioBuffer,
      { skipPreProcessing: true },
    );
    releaseAll.mockClear(); // the load releases whatever was held
    const upstream = vi.fn();
    player.onMessage('note:off', upstream);
    const playing = () => voices.filter((voice) => voice.state === 'PLAYING').length;
    return { player, voices, playing, noteOff, releaseAll, setPitch, upstream, ...test };
  }

  it('releases only deferred keys and drains multiple pitches and counts once', async () => {
    const { player, voices, playing, noteOff, releaseAll, upstream } = await setup();
    player.play(60);
    player.play(64);
    player.play(67);
    player.setSustainPedal(true);
    expect(player.holdEnabled).toBe(false);
    player.release(64, 10);
    player.release(64);
    player.release(67);
    expect(playing()).toBe(3);
    expect(noteOff).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();

    player.setSustainPedal(false);
    expect(voices.find((voice) => voice.midiNote === 60)?.state).toBe('PLAYING');
    expect(playing()).toBe(1);
    expect(releaseAll).not.toHaveBeenCalled();
    expect(noteOff.mock.calls).toEqual([[64], [64], [67]]);
    expect(upstream.mock.calls.map(([message]) => message.midiNote)).toEqual([64, 64, 67]);
    player.setSustainPedal(false);
    expect(noteOff).toHaveBeenCalledTimes(3);
    player.release(60);
    expect(playing()).toBe(0);
  });

  it('returns a legato voice to a still-held key on pedal-up', async () => {
    const { player, voices, setPitch } = await setup();
    player.setLegato({ mode: 'always' });
    player.play(60);
    player.play(64);
    player.setSustainPedal(true);
    player.release(64);
    expect(voices[0].midiNote).toBe(64);
    player.setSustainPedal(false);
    expect(voices[0].state).toBe('PLAYING');
    expect(voices[0].midiNote).toBe(60);
    expect(setPitch).toHaveBeenLastCalledWith(60, 0, 0, 0);
  });

  it.each(['hold', 'lock'] as const)('keeps explicit %s independent of the pedal', async (mode) => {
    const { player, playing, noteOff, releaseAll } = await setup();
    const setHold = (enabled: boolean) =>
      mode === 'hold' ? player.setHoldEnabled(enabled) : player.setHoldLocked(enabled);
    player.play(60);
    player.setSustainPedal(true);
    player.release(60);
    setHold(true);
    player.setSustainPedal(false);
    expect(playing()).toBe(1);
    expect(noteOff).not.toHaveBeenCalled();
    expect(releaseAll).not.toHaveBeenCalled();
    setHold(false);
    expect(playing()).toBe(0);
    expect(releaseAll).toHaveBeenCalledOnce();

    // Disabling explicit hold while the pedal stays down keeps release-all semantics.
    setHold(true);
    player.setSustainPedal(true);
    player.play(64);
    player.release(64);
    setHold(false);
    expect(playing()).toBe(0);
    player.play(67);
    player.release(67);
    expect(playing()).toBe(1);
    player.setSustainPedal(false);
    expect(playing()).toBe(0);
    expect(noteOff.mock.calls).toEqual([[67]]);
  });

  it('preserves ordinary pedal looping and a loop enabled before pedal-down', async () => {
    const { player, ofType } = await setup();
    const loop = () => ofType('voice:setLoopEnabled').map((message) => message.value);
    player.setSustainPedal(true);
    expect(loop().at(-1)).toBe(true);
    player.setSustainPedal(false);
    expect(loop().at(-1)).toBe(false);
    player.setLoopEnabled(true);
    const count = loop().length;
    player.setSustainPedal(true);
    player.setSustainPedal(false);
    expect(loop()).toHaveLength(count);
  });

  it('applies a transpose set before init to the processor and the voice effects', async () => {
    const { player, ofType } = await setup((player) => player.transpose(12));
    expect(ofType('pool:setPitchOffset')[0].value).toBe(12);
    player.play(60);
    // The AM LFO sits an octave above the sounding note by default.
    const amNotes = getTestLFOs().flatMap((lfo) => lfo.setMusicalNote.mock.calls.map(([n]) => n));
    expect(amNotes).toContain(84);
  });

  it('schedules both loop edges at one event time even if the audio clock advances', async () => {
    const { player, worklet } = await setup();
    const start = vi.spyOn(worklet.parameters.get('loopStart')!, 'setValueAtTime');
    const end = vi.spyOn(worklet.parameters.get('loopEnd')!, 'setValueAtTime');
    vi.spyOn(player, 'now', 'get')
      .mockReturnValueOnce(2)
      .mockReturnValue(2 + 128 / 48000);

    player.setLoopRange(0.1, 0.2);

    expect(start.mock.calls).toEqual([[0.1, 2.001]]);
    expect(end.mock.calls).toEqual([[0.2, 2.001]]);
  });

  it('emits loop-range:updated once for individual edge changes and setLoopRange', async () => {
    const { player } = await setup();
    const onUpdated = vi.fn();
    player.onMessage('loop-range:updated', onUpdated);

    player.setLoopStart(0.1);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'loop-range:updated', loopStart: 0.1, loopEnd: 1 }),
    );

    player.setLoopRange(0.2, 0.6);
    expect(onUpdated).toHaveBeenCalledTimes(2);
    expect(onUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'loop-range:updated', loopStart: 0.2, loopEnd: 0.6 }),
    );
  });

  it('schedules both trim edges at one event time even if the audio clock advances', async () => {
    const { player, worklet } = await setup();
    const start = vi.spyOn(worklet.parameters.get('trimStart')!, 'setValueAtTime');
    const end = vi.spyOn(worklet.parameters.get('trimEnd')!, 'setValueAtTime');
    vi.spyOn(player, 'now', 'get')
      .mockReturnValueOnce(2)
      .mockReturnValue(2 + 128 / 48000);

    player.setTrimRange(0.1, 0.5);

    expect(start.mock.calls).toEqual([[0.1, 2.001]]);
    expect(end.mock.calls).toEqual([[0.5, 2.001]]);
    expect(player.trimStart).toBe(0.1);
    expect(player.trimEnd).toBe(0.5);
  });

  it('sets and reads individual trim edges via setTrimStart/setTrimEnd and trimStart/trimEnd', async () => {
    const { player, worklet } = await setup();
    const start = vi.spyOn(worklet.parameters.get('trimStart')!, 'setValueAtTime');
    const end = vi.spyOn(worklet.parameters.get('trimEnd')!, 'setValueAtTime');

    player.setTrimStart(0.1);
    expect(start).toHaveBeenCalledWith(0.1, expect.any(Number));
    expect(player.trimStart).toBe(0.1);

    player.setTrimEnd(0.5);
    expect(end).toHaveBeenCalledWith(0.5, expect.any(Number));
    expect(player.trimEnd).toBe(0.5);
  });

  it('rejects a non-finite trim edge without touching either param', async () => {
    const { player, worklet } = await setup();
    const start = worklet.parameters.get('trimStart')!;
    const end = worklet.parameters.get('trimEnd')!;
    const calls = [
      vi.spyOn(start, 'cancelScheduledValues'),
      vi.spyOn(start, 'setValueAtTime'),
      vi.spyOn(end, 'cancelScheduledValues'),
      vi.spyOn(end, 'setValueAtTime'),
    ];

    expect(() => player.setTrimRange(0.1, NaN)).toThrow(RangeError);
    for (const spy of calls) expect(spy).not.toHaveBeenCalled();
  });

  it('posts note-off untagged at the scheduled time and tells the bus the sounding note', async () => {
    const { player, ofType, noteOff, upstream } = await setup();
    player.transpose(2);
    player.play(60);
    player.release(60, 0.5);
    expect(ofType('pool:noteOff')).toEqual([
      { type: 'pool:noteOff', midiNote: 60, timestamp: 0.5 },
    ]);
    expect(noteOff).toHaveBeenCalledWith(62);
    expect(upstream).toHaveBeenCalledWith(expect.objectContaining({ midiNote: 60 }));
  });
});
