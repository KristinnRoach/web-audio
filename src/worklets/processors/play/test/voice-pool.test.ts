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
      expect.objectContaining({ type: 'voice:retuned', midiNote: 60, fallback: true }),
    );
  });
});

describe('pooled sample-player processors', () => {
  setupProcessorGlobals();

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
    expect(ended()).toEqual([{ type: 'voice:ended', triggerId: 42 }]);
    expect(processor.engine.isPlaying).toBe(false);

    // Loading again while idle must not duplicate the completion.
    load();
    expect(ended()).toHaveLength(1);
  });

  it('share one pool by id and start the note on the voice it picks', async () => {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const create = () =>
      new (SamplePlayerProcessor as any)({ processorOptions: { poolId: 'test-pool' } });
    const [first, second] = [create(), create()];
    for (const processor of [first, second]) {
      processor.port.onmessage({
        data: { type: 'voice:setBuffer', buffer: [new Float32Array(TEST_SAMPLE_RATE)] },
      });
    }
    const send = (midiNote: number) =>
      first.port.onmessage({
        data: { type: 'pool:noteOn', triggerId: midiNote, midiNote, timestamp: 0, glideTime: 0 },
      });
    const outputs = () => [[new Float32Array(128), new Float32Array(128)], [new Float32Array(128)]];
    const started = (processor: any) =>
      processor.port.postMessage.mock.calls
        .map(([message]: any) => message)
        .filter((message: any) => message.type === 'voice:started')
        .map((message: any) => message.midiNote);

    // Both events arrive on the first voice's port; the second voice takes the second note.
    send(60);
    send(64);
    second.process([], outputs(), makeParameters());
    expect(started(first)).toEqual([60]);
    expect(started(second)).toEqual([64]);
    expect(first.engine.isPlaying && second.engine.isPlaying).toBe(true);

    // A reload is announced on one port; notes wait until every voice has it.
    const load = (processor: any) =>
      processor.port.onmessage({
        data: {
          type: 'voice:setBuffer',
          bufferId: 1,
          buffer: [new Float32Array(TEST_SAMPLE_RATE)],
        },
      });
    first.port.onmessage({ data: { type: 'pool:expectBuffer', bufferId: 1 } });
    load(first);
    send(67);
    send(72);
    first.process([], outputs(), makeParameters());
    expect(started(second)).toEqual([64]);
    load(second);
    first.process([], outputs(), makeParameters());
    expect(started(first)).toEqual([60, 67]);
    expect(started(second)).toEqual([64, 72]);

    first.port.onmessage({ data: { type: 'pool:dispose' } });
  });
});
