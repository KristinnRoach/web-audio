import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { SampleVoice } from './SampleVoice';
import { VoiceState } from '../VoiceState';
import { createDefaultSampleEnvelopeConfig } from './sample-envelope-policy';

const SAMPLE_RATE = 48000;

/**
 * Web Audio stubs, installed before SampleVoice is imported because modules in
 * its import graph subclass AudioWorkletNode at load time.
 */
const audio = vi.hoisted(() => {
  const PARAM_NAMES = ['playbackRate', 'detune', 'velocity', 'loopStart', 'loopEnd'];

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

vi.mock('@/nodes/effects/HarmonicFeedback', () => ({
  HarmonicFeedback: class {
    input = { connect() {} };
    output = { connect() {} };
    setPitch = vi.fn();
    trigger() {}
  },
}));

const fakeBuffer = () =>
  ({
    sampleRate: SAMPLE_RATE,
    duration: 1,
    length: 8,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(8),
    copyFromChannel: (destination: Float32Array) => destination.set(new Float32Array(8)),
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
  await voice.loadBuffer(fakeBuffer());
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

  it('retunes without restarting the source, velocity or envelopes', async () => {
    const voice = await loadedVoice();
    voice.setPitchOffset(12);
    trigger(voice, 60);
    audio.posted = [];
    const timestamp = voice.triggerTimestamp;

    expect(voice.retune(72, 0.2, 0.3)).toBe(72);
    expect(audio.posted).toEqual([
      { type: 'voice:setRate', value: 4, timestamp: 0.2, glideSeconds: 0.3 },
    ]);
    expect(voice.midiNote).toBe(72);
    expect(voice.triggerTimestamp).toBe(timestamp);
    voice.release();
    expect(voice.retune(60)).toBeNull();
    voice.stop();
  });

  it('uses only current playing reports for pitch-loop eligibility', async () => {
    const voice = await loadedVoice();
    voice.setLoopEnabled(true);
    trigger(voice);
    const report = (triggerId: number, isInPitchLoop: boolean) =>
      audio.port.onmessage({ data: { type: 'loop:range', triggerId, isInPitchLoop } });
    expect(voice.isInPitchLoop).toBe(false);
    report(1, true);
    expect(voice.isInPitchLoop).toBe(true);
    voice.setLoopEnabled(false);
    expect(voice.isInPitchLoop).toBe(false);
    // The processor skips unchanged reports, so a quick off/on keeps the last one.
    voice.setLoopEnabled(true);
    expect(voice.isInPitchLoop).toBe(true);
    voice.stop();
    voice.setLoopEnabled(true);
    trigger(voice);
    report(1, true);
    expect(voice.isInPitchLoop).toBe(false);
    report(2, true);
    expect(voice.isInPitchLoop).toBe(true);
    report(2, false);
    expect(voice.isInPitchLoop).toBe(false);
    voice.stop();
  });

  it('adds the pitch offset to new notes and retunes a held one', async () => {
    const voice = await loadedVoice();
    voice.setPitchOffset(12);
    trigger(voice, 60);
    expect(audio.posted.find((m) => m.type === 'voice:start')).toMatchObject({ playbackRate: 2 });

    voice.setPitchOffset(-12);
    expect(audio.posted.at(-1)).toMatchObject({ type: 'voice:setRate', value: 0.5 });
    expect(voice.midiNote).toBe(60);
  });

  it('retunes the feedback of a held note with the pitch offset', async () => {
    const context = { currentTime: 0, sampleRate: SAMPLE_RATE } as unknown as AudioContext;
    const voice = new SampleVoice(context, { internalSignalChain: ['feedback'] });
    await voice.init();
    await voice.loadBuffer(fakeBuffer());
    audio.port.onmessage({ data: { type: 'voice:loaded', durationSeconds: 1 } });
    const { setPitch } = voice.feedback!;

    voice.setPitchOffset(2);
    expect(setPitch).not.toHaveBeenCalled();

    trigger(voice, 60);
    voice.setPitchOffset(-3);
    expect(vi.mocked(setPitch).mock.calls.at(-1)?.[0]).toBe(57);
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

    endPlayback(1);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(voice.midiNote).toBeNull();
    expect(events).toEqual(['voice:started', 'voice:releasing', 'voice:stopped']);
  });

  it('sends every envelope to the processor in its target units', async () => {
    const voice = newVoice(true);
    await voice.init();
    // SamplePlayer owns the configs, so a fresh voice sends none of its own.
    expect(audio.posted.some((m) => m.type === 'setEnvelope')).toBe(false);
    expect(voice.envelopeIds).toEqual(['amp', 'pitch', 'filter', 'pan']);

    audio.posted = [];
    voice.setEnvelopeConfig('pitch', createDefaultSampleEnvelopeConfig('pitch', 1));
    // Pitch in cents with linear curves.
    const [pitch] = audio.posted;
    expect(pitch).toMatchObject({ type: 'setEnvelope', target: 'detune' });
    expect(pitch.value.depth).toBe(1200);
    expect(pitch.value.shape.points.every((p: any) => p.curve === 'linear')).toBe(true);

    voice.setEnvelopeConfig('pitch', {
      ...createDefaultSampleEnvelopeConfig('pitch', 1),
      enabled: false,
    });
    expect(audio.posted.at(-1)).toEqual({ type: 'setEnvelope', target: 'detune', value: null });
  });

  it('sends the note with its start and leaves the end of the release to the processor', async () => {
    const voice = await loadedVoice();
    trigger(voice, 72);
    expect(audio.posted.at(-1)).toEqual({
      type: 'voice:start',
      timestamp: 0,
      triggerId: 1,
      playbackRate: 2,
      velocity: 100,
    });

    voice.release({ secondsFromNow: 2 });
    expect(audio.posted.at(-1)).toEqual({ type: 'voice:release', timestamp: 2 });
    expect(voice.state).toBe(VoiceState.RELEASING);
    endPlayback(1);
    expect(voice.state).toBe(VoiceState.AVAILABLE);
  });

  it('leaves note-off to the processor while the amp envelope is off', async () => {
    const voice = await loadedVoice();
    voice.setEnvelopeConfig('amp', {
      ...createDefaultSampleEnvelopeConfig('amp', 1),
      enabled: false,
    });
    trigger(voice);
    voice.release({ secondsFromNow: 2 });

    // The processor stops a release with no gain envelope.
    expect(audio.posted.at(-1)).toEqual({ type: 'voice:release', timestamp: 2 });
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
    audio.posted = [];
    voice.stop();
    voice.stop();

    expect(voice.state).toBe(VoiceState.AVAILABLE);
    expect(sentTypes()).toEqual(['voice:stop']);
  });

  it('sends a synchronous stop and retrigger in order', async () => {
    const voice = await loadedVoice();
    trigger(voice, 60);

    voice.stop();
    expect(voice.state).toBe(VoiceState.AVAILABLE);

    trigger(voice, 64);
    vi.runAllTimers();
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(voice.midiNote).toBe(64);
    // The processor lets the start supersede the stop.
    expect(sentTypes().slice(-2)).toEqual(['voice:stop', 'voice:start']);
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

  it('leaves a future stop to the processor clock', async () => {
    const voice = await loadedVoice();
    trigger(voice);

    voice.stop(0.5); // context currentTime is 0 in this suite

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

    await voice.loadBuffer(fakeBuffer());
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

it('loads identical audio into multiple voices without altering the shared Brave buffer', async () => {
  const channels = [new Float32Array(1024).fill(0.5), new Float32Array(1024).fill(-0.25)];
  const originals = channels.map((data) => data.slice());
  const scale = 0.999;
  const getChannelData = vi.fn((channel: number) => {
    const data = channels[channel];
    for (let i = 0; i < data.length; i++) data[i] *= scale;
    return data;
  });
  const copyFromChannel = vi.fn((destination: Float32Array, channel: number) => {
    destination.set(channels[channel].map((sample) => sample * scale));
  });
  const buffer = {
    length: 1024,
    duration: 1024 / SAMPLE_RATE,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 2,
    getChannelData,
    copyFromChannel,
  } as unknown as AudioBuffer;
  const messages: Float32Array[][] = [];
  for (let i = 0; i < 16; i++) {
    const voice = newVoice();
    await voice.init();
    await voice.loadBuffer(buffer);
    messages.push(audio.posted.find((message) => message.type === 'voice:setBuffer').buffer);
  }
  for (const message of messages) {
    expect(message).toEqual(originals.map((data) => data.map((sample) => sample * scale)));
  }
  expect(channels).toEqual(originals);
  expect(getChannelData).not.toHaveBeenCalled();
  expect(copyFromChannel).toHaveBeenCalledTimes(32);
});
