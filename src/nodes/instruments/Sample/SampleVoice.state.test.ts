import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { SampleVoice } from './SampleVoice';
import { VoiceState } from '../VoiceState';
import { createDefaultSampleEnvelopeConfig } from './sample-envelope-policy';
import type { EnvelopeConfig } from './envelope-config';

const SAMPLE_RATE = 48000;

/**
 * Web Audio stubs, installed before SampleVoice is imported because modules in
 * its import graph subclass AudioWorkletNode at load time.
 */
const audio = vi.hoisted(() => {
  const PARAM_NAMES = ['envGain', 'playbackRate', 'detune', 'velocity', 'loopStart', 'loopEnd'];

  const noop = () => {};
  const fakeParam = () =>
    ({
      value: 1,
      linearRampToValueAtTime: noop,
      cancelScheduledValues: noop,
      cancelAndHoldAtTime: noop,
      setValueAtTime: noop,
      exponentialRampToValueAtTime: noop,
      setTargetAtTime: noop,
      setValueCurveAtTime: noop,
    }) as unknown as AudioParam;

  /** The single worklet port of the most recently constructed voice. */
  const latest = {
    port: null as unknown as { postMessage: (m: any) => void; onmessage: (e: any) => void },
    posted: [] as any[],
  };

  class FakeAudioWorkletNode {
    parameters = new Map(PARAM_NAMES.map((name) => [name, fakeParam()]));
    port = {
      postMessage: (msg: any) => latest.posted.push(msg),
      start: () => {},
      onmessage: null,
    };
    constructor() {
      latest.port = this.port as any;
    }
    connect() {}
    disconnect() {}
  }

  class FakeGainNode {
    gain = fakeParam();
    connect() {}
    disconnect() {}
  }

  class FakeBiquadFilterNode {
    frequency = fakeParam();
    detune = fakeParam();
    Q = fakeParam();
    connect() {}
    disconnect() {}
  }

  Object.assign(globalThis, {
    AudioWorkletNode: FakeAudioWorkletNode,
    GainNode: FakeGainNode,
    BiquadFilterNode: FakeBiquadFilterNode,
  });
  return latest;
});

const fakeBuffer = () =>
  ({
    sampleRate: SAMPLE_RATE,
    duration: 1,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(8),
  }) as unknown as AudioBuffer;

/** Keep effects out of state tests unless the filter is needed. */
function newVoice(withFilter = false) {
  audio.posted = [];
  const context = { currentTime: 0, sampleRate: SAMPLE_RATE } as unknown as AudioContext;
  return new SampleVoice(context, { internalSignalChain: withFilter ? ['lpf'] : [] });
}

async function loadedVoice(withFilter = false) {
  const voice = newVoice(withFilter);
  await voice.init();
  await voice.loadAudioData([fakeBuffer()]);
  audio.port.onmessage({ data: { type: 'voice:loaded', durationSeconds: 1 } });
  audio.posted = [];
  return voice;
}

const trigger = (voice: SampleVoice, midiNote = 60) => voice.trigger({ midiNote, velocity: 100 });
const sentTypes = () => audio.posted.map((m) => m.type);
const endPlayback = (triggerId = 1) =>
  audio.port.onmessage({ data: { type: 'voice:ended', triggerId } });

describe('SampleVoice state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('adds the pitch offset to new notes and retunes a held one', async () => {
    const voice = await loadedVoice();
    const set = vi.spyOn(voice.getParam('playbackRate')!, 'setValueAtTime');
    voice.setPitchOffset(12);
    trigger(voice, 60);
    expect(set).toHaveBeenLastCalledWith(2, 0.001);

    const glide = vi.spyOn(voice.getParam('playbackRate')!, 'linearRampToValueAtTime');
    voice.setPitchOffset(-12);
    expect(glide.mock.calls.at(-1)?.[0]).toBe(0.5);
    expect(voice.midiNote).toBe(60);
  });

  it('schedules both loop points together even if the audio clock advances', async () => {
    const voice = await loadedVoice();
    const start = vi.spyOn(voice.getParam('loopStart')!, 'setValueAtTime');
    const end = vi.spyOn(voice.getParam('loopEnd')!, 'setValueAtTime');
    vi.spyOn(voice, 'now', 'get')
      .mockReturnValueOnce(2)
      .mockReturnValue(2 + 128 / SAMPLE_RATE);

    voice.setLoopPoints(0.1, 0.2, 1);

    expect(start.mock.calls).toEqual([[0.1, 2.001]]);
    expect(end.mock.calls).toEqual([[0.2, 2.001]]);
  });

  it('refuses to trigger before audio is loaded', async () => {
    const voice = newVoice();
    await voice.init();

    expect(trigger(voice)).toBeNull();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes()).not.toContain('voice:start');
  });

  it('owns the complete lifecycle and reports each transition synchronously', async () => {
    const voice = await loadedVoice();
    const events: string[] = [];
    ['voice:started', 'voice:releasing', 'voice:stopped'].forEach((type) => {
      voice.onMessage(type, () => events.push(type));
    });

    voice.release();
    expect(voice.state).toBe(VoiceState.AVAILABLE);

    expect(trigger(voice)).toBe(60);
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(60);

    voice.release();
    voice.release();
    expect(voice.state).toBe(VoiceState.RELEASING);

    vi.runAllTimers();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.midiNote).toBeNull();
    expect(events).toEqual(['voice:started', 'voice:releasing', 'voice:stopped']);
  });

  it('reports and stops after the amplitude release even when pitch releases longer', async () => {
    const voice = await loadedVoice();
    const pitchConfig = createDefaultSampleEnvelopeConfig('pitch', 1);
    voice.setEnvelopeConfig('pitch', {
      ...pitchConfig,
      enabled: true,
      shape: {
        ...pitchConfig.shape,
        points: [
          { time: 0, value: 0 },
          { time: 5, value: 1 },
        ],
      },
    });
    let releaseDuration: number | undefined;
    voice.onMessage('voice:releasing', (msg: any) => (releaseDuration = msg.releaseDuration));

    trigger(voice);
    voice.release();

    expect(voice.envelopes.get('pitch')!.releaseDuration()).toBeGreaterThan(voice.releaseTime);
    expect(releaseDuration).toBe(voice.releaseTime);
    const stopAfterMs = voice.releaseTime * 1000 + 50;
    vi.advanceTimersByTime(stopAfterMs - 1);
    expect(voice.state).toBe(VoiceState.RELEASING);
    vi.advanceTimersByTime(1);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it('waits for the scheduled release and amplitude tail before stopping', async () => {
    const voice = await loadedVoice();
    trigger(voice);

    voice.release({ secondsFromNow: 2 });

    const stopAfterMs = (2 + voice.releaseTime) * 1000 + 50;
    vi.advanceTimersByTime(stopAfterMs - 1);
    expect(voice.state).toBe(VoiceState.RELEASING);
    expect(sentTypes()).not.toContain('voice:stop');

    vi.advanceTimersByTime(1);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it.each([0, 2])(
    'preserves the amp release when disabled after note-off scheduled %s seconds ahead',
    async (secondsFromNow) => {
      const voice = await loadedVoice();
      trigger(voice);
      const releaseDuration = voice.releaseTime;
      voice.release({ secondsFromNow });
      const gain = voice.getParam('envGain')!;
      const cancel = vi.spyOn(gain, 'cancelScheduledValues');
      const target = vi.spyOn(gain, 'setTargetAtTime');

      voice.setEnvelopeConfig('amp', {
        ...createDefaultSampleEnvelopeConfig('amp', 1),
        enabled: false,
      });

      expect(cancel).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
      const stopAfterMs = (secondsFromNow + releaseDuration) * 1000 + 50;
      vi.advanceTimersByTime(stopAfterMs - 1);
      expect(voice.state).toBe(VoiceState.RELEASING);
      vi.advanceTimersByTime(1);
      expect(voice.state).toBe(VoiceState.AVAILABLE);
    },
  );

  it.each([true, false])('keeps velocity out of amp gain when enabled=%s', async (enabled) => {
    const voice = await loadedVoice();
    const config = createDefaultSampleEnvelopeConfig('amp', 1);
    voice.setEnvelopeConfig('amp', { ...config, enabled });
    const gain = voice.getParam('envGain')!;
    const peak = vi.spyOn(gain, 'exponentialRampToValueAtTime');
    const gate = vi.spyOn(gain, 'setTargetAtTime');
    const velocity = vi.spyOn(voice.getParam('velocity')!, 'setValueAtTime');

    voice.trigger({ midiNote: 60, velocity: 64 });

    expect(velocity).toHaveBeenCalledWith(64, expect.any(Number));
    const presetPeak = Math.max(...config.shape.points.map((point) => point.value));
    if (enabled) expect(peak).toHaveBeenCalledWith(presetPeak, expect.any(Number));
    else expect(gate).toHaveBeenCalledWith(1, 0, expect.any(Number));
  });

  it.each(['pitch', 'filter'] as const)(
    'resets inactive %s detune immediately at note start but smooths live disable',
    async (id) => {
      const voice = await loadedVoice(id === 'filter');
      const config = createDefaultSampleEnvelopeConfig(id, 1);
      voice.setEnvelopeConfig(id, {
        ...config,
        enabled: true,
        shape: {
          ...config.shape,
          sustainPoint: 0,
          releasePoint: 0,
          points: [
            { time: 0, value: 1 },
            { time: 1, value: 0 },
          ],
        },
      });
      trigger(voice);
      const detune = voice.getParam(id === 'pitch' ? 'detune' : 'lpfDetune')!;
      const set = vi.spyOn(detune, 'setValueAtTime');
      const target = vi.spyOn(detune, 'setTargetAtTime');
      voice.setEnvelopeConfig(id, { ...config, enabled: false });
      expect(target).toHaveBeenCalledWith(0, 0, expect.any(Number));
      voice.stop();
      detune.value = 1200;
      set.mockClear();
      target.mockClear();

      voice.trigger({ midiNote: 60, velocity: 100, secondsFromNow: 2 });

      expect(set).toHaveBeenCalledWith(0, 2);
      expect(target).not.toHaveBeenCalled();
    },
  );

  it('preserves sustain glides and loop edits with the note’s depth and rate mapping', async () => {
    const voice = await loadedVoice();
    const config: EnvelopeConfig = {
      enabled: true,
      depth: 0.5,
      timeScale: 0.75,
      playbackRateSync: true,
      shape: {
        mode: { type: 'sustain' },
        sustainPoint: 1,
        releasePoint: 1,
        points: [
          { time: 0, value: 0 },
          { time: 0.5, value: 1 },
          { time: 1, value: 0 },
        ],
      },
    };
    voice.setEnvelopeConfig('pitch', config);
    const detune = voice.getParam('detune')!;
    const ramp = vi.spyOn(detune, 'linearRampToValueAtTime');
    const set = vi.spyOn(detune, 'setValueAtTime');
    const envelope = voice.envelopes.get('pitch')!;

    trigger(voice, 72); // Playback rate 2, so the envelope runs at 1.5x.
    expect(ramp).toHaveBeenCalledWith(600, expect.closeTo(1 / 3, 6));

    Object.assign(envelope.clock, { currentTime: 0.5 });
    const shape = {
      ...config.shape,
      points: config.shape.points.map((p) => ({ ...p, value: p.value / 2 })),
    };
    voice.setEnvelopeConfig('pitch', { ...config, shape });
    expect(ramp).toHaveBeenCalledWith(300, 0.52);

    Object.assign(envelope.clock, { currentTime: 0.55 });
    const loop = { ...shape, mode: { type: 'loop' as const } };
    voice.setEnvelopeConfig('pitch', { ...config, shape: loop });
    expect(set).toHaveBeenCalledWith(300, 0.55); // Pick up at sustain, without a new attack.
    const boundary = 0.55 + 1 / 3;
    expect(ramp).toHaveBeenCalledWith(0, expect.closeTo(boundary, 6));

    voice.setEnvelopeConfig('pitch', { ...config, shape: loop, depth: 0.25, timeScale: 1.25 });
    expect(ramp).toHaveBeenCalledWith(150, expect.closeTo(boundary + 0.2, 6));
    voice.stop();
  });

  it('stops rather than retriggering an active voice', async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    expect(trigger(voice, 64)).toBeNull();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.midiNote).toBeNull();
  });

  it('stops a releasing voice idempotently', async () => {
    const voice = await loadedVoice();
    trigger(voice);
    voice.release();
    voice.stop();
    voice.stop();
    vi.runAllTimers();

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes().filter((t) => t === 'voice:stop')).toHaveLength(1);
  });

  it('coalesces a synchronous stop and retrigger', async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    voice.stop();
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes()).not.toContain('voice:stop');

    trigger(voice, 64);
    vi.runAllTimers();
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(64);
    expect(sentTypes()).not.toContain('voice:stop');
  });

  it('ignores completion from an older playback with the same timestamp', async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);
    voice.stop();
    trigger(voice, 64);

    const starts = audio.posted.filter((message) => message.type === 'voice:start');
    expect(starts.map(({ timestamp }) => timestamp)).toEqual([0, 0]);
    expect(starts.map(({ triggerId }) => triggerId)).toEqual([1, 2]);

    endPlayback(1);
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(64);

    endPlayback(2);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it('holds a stop scheduled for a future timestamp', async () => {
    const voice = await loadedVoice();
    trigger(voice);

    voice.stop(0.5); // context currentTime is 0 in this suite

    expect(sentTypes()).not.toContain('voice:stop');
    vi.advanceTimersByTime(499);
    expect(sentTypes()).not.toContain('voice:stop');

    vi.advanceTimersByTime(2);
    expect(audio.posted.at(-1)).toEqual({ type: 'voice:stop', timestamp: 0.5 });
  });

  it('accepts current natural completion and ignores completion from the previous note', async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    endPlayback(1);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.midiNote).toBeNull();
    voice.trigger({ midiNote: 64, velocity: 100, secondsFromNow: 1 });

    endPlayback(1);

    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(64);
  });

  it('distinguishes a load acknowledgement from replacing the loaded audio data', async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    audio.port.onmessage({ data: { type: 'voice:loaded', durationSeconds: 1 } });

    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(60);

    await voice.loadAudioData([fakeBuffer()]);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it('includes voiceId in voice:started', async () => {
    const voice = await loadedVoice();
    const started = vi.fn();
    voice.onMessage('voice:started', started);
    trigger(voice, 60);

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: voice.nodeId, midiNote: 60 }),
    );
  });

  it('forwards only the current note’s ranges, tagged with voice and note', async () => {
    const voice = await loadedVoice();
    const ranges = vi.fn();
    voice.onMessage('loop:range', ranges);
    const range = (triggerId: number) =>
      audio.port.onmessage({ data: { type: 'loop:range', loopStart: 0, loopEnd: 1, triggerId } });

    trigger(voice, 60);
    range(0);
    range(1);
    endPlayback(1);
    range(1);
    trigger(voice, 64);
    range(1);
    range(2);

    expect(ranges.mock.calls.map(([data]) => data.midiNote)).toEqual([60, 64]);
    expect(ranges.mock.calls[0][0]).toMatchObject({
      voiceId: voice.nodeId,
      loopStart: 0,
      loopEnd: 1,
    });
    expect(ranges.mock.calls[0][0]).not.toHaveProperty('triggerId');
  });

  it('scales loop envelopes against the processed loop length', async () => {
    const loopTimeScale = async (idleReport: boolean) => {
      const voice = await loadedVoice();
      const ranges = vi.fn();
      voice.onMessage('loop:range', ranges);
      voice.setLoopEnabled(true);
      const config = createDefaultSampleEnvelopeConfig('pitch', 1);
      voice.setEnvelopeConfig('pitch', {
        ...config,
        enabled: true,
        shape: { ...config.shape, mode: { type: 'loop' } },
      });
      if (idleReport) {
        audio.port.onmessage({
          data: {
            type: 'loop:range',
            loopStart: 0.01,
            loopEnd: 0.49,
            requestedLoopSeconds: 0.5,
            idle: true,
          },
        });
      }
      const envTrigger = vi.spyOn(voice.envelopes.get('pitch')!, 'trigger');
      trigger(voice);
      voice.stop();
      expect(ranges).not.toHaveBeenCalled(); // idle reports stay inside the voice
      return envTrigger.mock.calls[0][1]!.timeScale ?? 1;
    };

    const withoutProcessedLoop = await loopTimeScale(false);
    const withProcessedLoop = await loopTimeScale(true);
    expect(withProcessedLoop).toBeGreaterThan(withoutProcessedLoop);
  });

  it('forwards only the current note’s position, tagged with voice and note', async () => {
    const voice = await loadedVoice();
    const positions = vi.fn();
    voice.onMessage('voice:position', positions);
    const position = (triggerId: number, value: number) =>
      audio.port.onmessage({ data: { type: 'voice:position', position: value, triggerId } });

    trigger(voice, 60);
    position(0, 0.1);
    position(1, 0.2);
    endPlayback(1);
    position(1, 0.3);

    expect(positions.mock.calls.map(([data]) => data)).toEqual([
      expect.objectContaining({ voiceId: voice.nodeId, midiNote: 60, position: 0.2 }),
    ]);
  });
});
