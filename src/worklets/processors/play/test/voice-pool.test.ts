import { describe, expect, it, vi } from 'vite-plus/test';
import { PoolVoice, VoicePool } from '../engine/voice-pool.js';
import { makeParameters, setupProcessorGlobals, TEST_SAMPLE_RATE } from './range-test-helpers';

function setup(voiceCount = 2) {
  const pool = new VoicePool();
  const voices = Array.from({ length: voiceCount }, () => {
    const engine = {
      loopEnabled: false,
      start: vi.fn(),
      stop: vi.fn(),
      release: vi.fn(),
      setNoteRate: vi.fn(),
    };
    const post = vi.fn();
    const voice = new PoolVoice(engine, post);
    pool.addVoice(voice);
    return { voice, engine, post };
  });
  const noteOn = (midiNote: number, timestamp: number) =>
    pool.schedule({ type: 'pool:noteOn', triggerId: midiNote, midiNote, timestamp, glideTime: 0 });
  return { pool, voices, noteOn };
}

describe('VoicePool', () => {
  it('decides a scheduled note from the voices as they are when it sounds', () => {
    const { pool, voices, noteOn } = setup(1);
    const [{ voice, engine }] = voices;
    noteOn(60, 0);
    noteOn(64, 1);
    pool.advance(0.5);
    expect(voice.midiNote).toBe(60);
    expect(engine.start).toHaveBeenCalledOnce();

    // The first note ends before the second is due, so nothing is stolen.
    voice.observe({ type: 'voice:ended' });
    pool.advance(1.5);
    expect(voice.midiNote).toBe(64);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('applies events in time order and reports each to the voice it touched', () => {
    const { pool, voices, noteOn } = setup();
    noteOn(64, 2);
    noteOn(60, 1);
    pool.schedule({ type: 'pool:noteOff', midiNote: 60, timestamp: 3 });
    pool.advance(10);

    expect(voices[0].post.mock.calls.map(([message]) => message.type)).toEqual([
      'voice:started',
      'voice:releasing',
    ]);
    expect(voices[0].post.mock.calls[0][0]).toMatchObject({ midiNote: 60, timestamp: 1 });
    expect(voices[1].voice.midiNote).toBe(64);
    expect(voices[0].engine.release).toHaveBeenCalledWith(3);
  });

  it('drops notes that have not sounded on all-notes-off', () => {
    const { pool, voices, noteOn } = setup();
    noteOn(60, 0);
    noteOn(64, 5);
    pool.advance(1);
    pool.schedule({ type: 'pool:allNotesOff', timestamp: 1 });
    pool.advance(10);

    expect(voices[0].voice.state).toBe('RELEASING');
    expect(voices[1].engine.start).not.toHaveBeenCalled();
  });

  it('leaves a fallback retune rate to the node', () => {
    const { pool, voices, noteOn } = setup(1);
    pool.allocator.legato = { mode: 'always' };
    noteOn(60, 0);
    pool.schedule({
      type: 'pool:noteOn',
      midiNote: 64,
      timestamp: 1,
      glideTime: 0,
      playbackRate: 2,
    });
    pool.schedule({ type: 'pool:noteOff', midiNote: 64, timestamp: 2 });
    pool.advance(10);

    expect(voices[0].engine.setNoteRate.mock.calls).toEqual([[1, 2, 0]]);
    expect(voices[0].post).toHaveBeenLastCalledWith(
      // Third pitch decision on this voice: start, retune, fallback.
      expect.objectContaining({ type: 'voice:retuned', midiNote: 60, fallback: true, pitchId: 3 }),
    );
  });
});

describe('sample-player processor voices', () => {
  setupProcessorGlobals();

  it('drops a rate answering a pitch decision the voice has moved on from', async () => {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const processor = new (SamplePlayerProcessor as any)();
    const setNoteRate = vi.spyOn(processor.engine, 'setNoteRate');
    processor.voice.pitchId = 2;
    processor.port.onmessage({ data: { type: 'voice:setRate', value: 2, pitchId: 1 } });
    expect(setNoteRate).not.toHaveBeenCalled();
    processor.port.onmessage({ data: { type: 'voice:setRate', value: 2, pitchId: 2 } });
    processor.port.onmessage({ data: { type: 'voice:setRate', value: 2 } });
    expect(setNoteRate).toHaveBeenCalledTimes(2);
  });

  it('reports completion when a buffer swap clears playback with a scheduled stop', async () => {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const processor = new (SamplePlayerProcessor as any)();
    const send = (data: object) => processor.port.onmessage({ data });
    const load = () =>
      send({ type: 'voice:setBuffer', buffer: [new Float32Array(TEST_SAMPLE_RATE)] });
    const ended = () =>
      processor.port.postMessage.mock.calls
        .map(([message]: any) => message)
        .filter((message: any) => message.type === 'voice:ended');

    load();
    send({ type: 'voice:start', triggerId: 42, timestamp: 0 });
    send({ type: 'voice:stop', timestamp: 1 });
    expect(processor.voice.state).toBe('AVAILABLE');
    expect(processor.engine.isPlaying).toBe(true);
    expect(ended()).toEqual([]);

    load();
    expect(ended()).toEqual([{ type: 'voice:ended', triggerId: 42, voice: 0 }]);
    expect(processor.engine.isPlaying).toBe(false);

    // Loading again while idle must not duplicate the completion.
    load();
    expect(ended()).toHaveLength(1);
  });

  it('renders every voice from one buffer, each to its own outputs', async () => {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const processor = new (SamplePlayerProcessor as any)({ processorOptions: { voiceCount: 2 } });
    const send = (data: object) => processor.port.onmessage({ data });
    const buffer = new Float32Array(TEST_SAMPLE_RATE).fill(0.5);
    // No `voice` index: one copy reaches both engines.
    send({ type: 'voice:setBuffer', buffer: [buffer] });
    const noteOn = (midiNote: number) =>
      send({ type: 'pool:noteOn', triggerId: midiNote, midiNote, timestamp: 0, glideTime: 0 });
    const reports = (type: string) =>
      processor.port.postMessage.mock.calls
        .map(([message]: any) => message)
        .filter((message: any) => message.type === type);

    noteOn(60);
    const stereo = () => [new Float32Array(128), new Float32Array(128)];
    const outputs = [stereo(), [new Float32Array(128)], stereo(), [new Float32Array(128)]];
    processor.process([], outputs, makeParameters());

    // One note: the first voice sounds on its outputs, the second stays silent.
    expect(reports('voice:loaded').map((message: any) => message.voice)).toEqual([0, 1]);
    expect(reports('voice:started')).toEqual([expect.objectContaining({ voice: 0, midiNote: 60 })]);
    expect(outputs[0][0].some((sample) => sample !== 0)).toBe(true);
    expect(outputs[2][0].every((sample) => sample === 0)).toBe(true);

    noteOn(64);
    processor.process([], outputs, makeParameters());
    expect(reports('voice:started')[1]).toMatchObject({ voice: 1, midiNote: 64 });
    expect(outputs[2][0].some((sample) => sample !== 0)).toBe(true);

    // A message with an index reaches only that voice.
    send({ type: 'voice:stop', voice: 1, timestamp: 0 });
    expect(processor.voices.map(({ voice }: any) => voice.state)).toEqual(['PLAYING', 'AVAILABLE']);
  });
});
