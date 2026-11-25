import { describe, expect, it, vi } from 'vite-plus/test';
import { PoolVoice, VoicePool } from '../engine/voice-pool.js';
import { makeParameters, setupProcessorGlobals, TEST_SAMPLE_RATE } from './range-test-helpers';

function setup(voiceCount = 2) {
  const pool = new VoicePool();
  const voices = Array.from({ length: voiceCount }, () => {
    const engine = {
      loopEnabled: false,
      isInPitchLoop: false,
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
  const noteOn = (midiNote: number, timestamp: number, glideTime = 0) =>
    pool.schedule({ type: 'pool:noteOn', triggerId: midiNote, midiNote, timestamp, glideTime });
  return { pool, voices, noteOn };
}

describe('VoicePool', () => {
  it('queues a scheduled flood with bounded timestamp comparisons and stable ties', () => {
    const { pool, voices } = setup(1);
    let timestampReads = 0;
    const events = Array.from({ length: 800 }, (_, index) => ({
      type: 'pool:noteOn',
      triggerId: index,
      midiNote: 60,
      glideTime: 0,
      // Interleaved on/off times, including ties, as in a scheduled note flood.
      get timestamp() {
        timestampReads++;
        return Math.floor(index / 2) * 0.005 + (index % 2 ? 0.15 : 0);
      },
    }));
    for (const event of events) pool.schedule(event);

    // Re-sorting the full queue per event reads timestamps over 600,000 times.
    // Binary insertion needs at most two reads per level for each event.
    expect(timestampReads).toBeLessThanOrEqual(
      2 * events.length * Math.ceil(Math.log2(events.length)),
    );
    const expected = [...events].sort((a, b) => a.timestamp - b.timestamp);
    pool.advance(10);
    expect(voices[0].engine.start.mock.calls.map(([triggerId]) => triggerId)).toEqual(
      expected.map((event) => event.triggerId),
    );
  });

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

  it('works out note rates from the pitch settings and glides from the last note applied', () => {
    const { pool, voices, noteOn } = setup(1);
    const [{ voice, engine }] = voices;
    pool.setPitchOffset(12, 0);
    noteOn(60, 0, 0.1);
    pool.advance(1);
    // The first note glides from middle C, as the player's first note always has.
    expect(engine.start).toHaveBeenLastCalledWith(60, 0, {
      midiNote: 60,
      velocity: undefined,
      playbackRate: 2,
      glideFrom: 2,
      glideSeconds: 0.1,
    });
    voice.observe({ type: 'voice:ended' });

    pool.setPitchEnabled(false, 1);
    noteOn(72, 1, 0.1);
    pool.advance(2);
    expect(engine.start.mock.lastCall?.[2]).toEqual({
      midiNote: 72,
      velocity: undefined,
      playbackRate: 1,
    });
    // The node still hears where the note glides from, for its effects.
    expect(voices[0].post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'voice:started', glideFromNote: 60 }),
    );
  });

  it('retunes a legato voice, and a fallback becomes the next glide origin', () => {
    const { pool, voices, noteOn } = setup();
    pool.allocator.legato = { mode: 'always', interval: [-5, 5] };
    noteOn(60, 0);
    noteOn(64, 1, 0.2);
    pool.schedule({ type: 'pool:noteOff', midiNote: 64, timestamp: 2 });
    noteOn(72, 3, 0.2);
    pool.advance(10);

    expect(voices[0].engine.setNoteRate.mock.calls).toEqual([
      [1, 2 ** (4 / 12), 0.2],
      [2, 1, 0.2],
    ]);
    expect(voices[0].post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'voice:retuned', midiNote: 60 }),
    );
    // Out of the legato interval: a new voice, gliding from the fallback note.
    expect(voices[1].engine.start.mock.lastCall?.[2]).toMatchObject({ glideFrom: 1 });
  });

  it('keeps a legato glide while pitch is off, but not a fallback glide', () => {
    const { pool, voices, noteOn } = setup();
    pool.allocator.legato = { mode: 'always' };
    noteOn(60, 0);
    pool.advance(1);
    pool.setPitchEnabled(false, 1);
    noteOn(64, 2, 0.2);
    pool.schedule({ type: 'pool:noteOff', midiNote: 64, timestamp: 3 });
    pool.advance(10);

    expect(voices[0].engine.setNoteRate.mock.calls.slice(1)).toEqual([
      [2, 1, 0.2],
      [3, 1, 0],
    ]);
  });

  it('retunes held notes when the pitch settings change', () => {
    const { pool, voices, noteOn } = setup();
    noteOn(60, 0);
    pool.advance(1);
    const [held, idle] = voices.map(({ engine }) => engine.setNoteRate);

    pool.setPitchOffset(12, 1);
    pool.setPitchOffset(12, 1);
    pool.setPitchEnabled(false, 2);
    pool.setPitchOffset(-12, 3);
    pool.setPitchEnabled(true, 4);

    expect(held.mock.calls).toEqual([
      [1, 2, 0.01],
      [2, 1, 0.1 / 3],
      [3, 1, 0],
      [4, 0.5, 0.01 / 3],
    ]);
    expect(idle.mock.calls).toEqual([[2, 1, 0.1 / 3]]);
  });
});

describe('sample-player processor voices', () => {
  setupProcessorGlobals();

  it('acknowledges handled messages without starting scheduled notes early', async () => {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const processor = new (SamplePlayerProcessor as any)();
    const send = (data: object) => processor.port.onmessage({ data });
    send({ type: 'voice:setBuffer', buffer: [new Float32Array(TEST_SAMPLE_RATE).fill(0.5)] });
    send({ type: 'pool:noteOn', triggerId: 1, midiNote: 60, timestamp: 0.5 });
    send({ type: 'flush', id: 42 });
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({ type: 'flushed', id: 42 });
    expect(processor.voice.state).toBe('AVAILABLE');
    processor.pool.advance(0.5);
    expect(processor.voice.state).toBe('AVAILABLE');
    processor.pool.advance(0.51);
    expect(processor.voice.state).toBe('PLAYING');
  });

  it('starts a tagged voice:start at the rate the pool works out', async () => {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const processor = new (SamplePlayerProcessor as any)();
    const start = vi.spyOn(processor.engine, 'start');
    processor.port.onmessage({ data: { type: 'pool:setPitchOffset', value: 12 } });
    processor.port.onmessage({
      data: { type: 'voice:start', voice: 0, triggerId: 1, timestamp: 0, midiNote: 60 },
    });
    expect(start.mock.lastCall?.[2]).toMatchObject({ playbackRate: 2 });
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
    expect(reports('voice:loaded')).toHaveLength(1);
    expect(reports('voice:loaded')[0]).not.toHaveProperty('voice');
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

  it('uses the latest rendered pitch-loop state while range reports are throttled', async ({
    onTestFinished,
  }) => {
    const { SamplePlayerProcessor } = await import('../sample-player-processor.js');
    const processor = new (SamplePlayerProcessor as any)();
    const send = (data: object) => processor.port.onmessage({ data });
    const noteOn = (midiNote: number, timestamp: number) =>
      send({ type: 'pool:noteOn', triggerId: midiNote, midiNote, timestamp });
    const reports = (type: string) =>
      processor.port.postMessage.mock.calls
        .map(([message]: any) => message)
        .filter((message: any) => message.type === type);

    let frame = 0;
    const renderBlock = (loopEnd: number) => {
      const output = new Float32Array(128);
      vi.stubGlobal('currentFrame', frame);
      vi.stubGlobal('currentTime', frame / TEST_SAMPLE_RATE);
      processor.process([], [[output]], makeParameters({ loopStart: 0.004, loopEnd }));
      frame += output.length;
    };
    onTestFinished(() => {
      vi.stubGlobal('currentFrame', 0);
      vi.stubGlobal('currentTime', 0);
    });

    send({ type: 'voice:setBuffer', buffer: [new Float32Array(TEST_SAMPLE_RATE)] });
    send({ type: 'voice:setLoopEnabled', value: true });
    send({ type: 'pool:setLegato', value: { mode: 'pitchLoop' } });
    noteOn(60, 0);
    renderBlock(0.006); // approaching the pitch loop
    renderBlock(0.006); // entered the pitch loop
    expect(reports('loop:range')).toEqual([expect.objectContaining({ isInPitchLoop: false })]);

    noteOn(64, frame / TEST_SAMPLE_RATE);
    renderBlock(0.006);
    expect(reports('voice:retuned')).toEqual([expect.objectContaining({ midiNote: 64 })]);

    // Let the display catch up, then switch to a time loop before it can post again.
    frame = TEST_SAMPLE_RATE / 20;
    renderBlock(0.006);
    renderBlock(0.2);
    expect(reports('loop:range').at(-1)).toMatchObject({ isInPitchLoop: true });

    noteOn(67, frame / TEST_SAMPLE_RATE);
    renderBlock(0.2);
    expect(reports('voice:started').map(({ midiNote }: { midiNote: number }) => midiNote)).toEqual([
      60, 67,
    ]);
  });
});
