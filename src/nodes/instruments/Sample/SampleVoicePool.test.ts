import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { initTestPlayer } from './test/initTestPlayer';
import type { SamplePlayer } from './SamplePlayer';
import type { Message, MessageHandler } from '../../../events';
import { VoiceState } from '../VoiceState';

type FakeEngine = Record<'start' | 'stop' | 'release' | 'setNoteRate', ReturnType<typeof vi.fn>>;
/** The fake engine behind a test voice, where the pool's decisions land. */
const engineOf = (voice: unknown) => (voice as { engine: FakeEngine }).engine;

vi.mock('./createSampleVoice', async () => {
  const { PoolVoice, VoicePool } =
    await import('../../../worklets/processors/play/engine/voice-pool.js');

  /** Stands in for a SampleVoice and its processor: messages reach a real VoicePool at once. */
  class TestVoice {
    state: VoiceState = VoiceState.AVAILABLE;
    midiNote: number | null = null;
    hasLoadedAudio = true;
    engine = {
      loopEnabled: true,
      start: vi.fn(),
      stop: vi.fn(),
      release: vi.fn(),
      setNoteRate: vi.fn(),
    };
    poolVoice = new PoolVoice(this.engine, (message: any) => this.#receive(message));
    handlers = new Map<string, Set<MessageHandler<Message>>>();

    constructor(private pool: InstanceType<typeof VoicePool>) {
      pool.addVoice(this.poolVoice);
    }

    onMessage(type: string, handler: MessageHandler<Message>) {
      const handlers = this.handlers.get(type) ?? new Set();
      handlers.add(handler);
      this.handlers.set(type, handlers);
      return () => handlers.delete(handler);
    }

    #emit(type: string, data = {}) {
      const message = { type, senderId: 'test', midiNote: this.midiNote, ...data };
      this.handlers.get(type)?.forEach((handler) => handler(message));
    }

    #receive({ type, ...data }: any) {
      if (type === 'voice:started') {
        if (this.state !== VoiceState.AVAILABLE) this.#emit('voice:stopped');
        this.state = VoiceState.PLAYING;
        this.midiNote = data.midiNote;
      } else if (type === 'voice:retuned') this.midiNote = data.midiNote;
      else if (type === 'voice:releasing') this.state = VoiceState.RELEASING;
      this.#emit(type, data);
    }

    /** Every event is due at once, so a test reads the decision on the next line. */
    sendToProcessor(message: any) {
      if (message.type === 'pool:setLegato') this.pool.allocator.legato = message.value;
      else {
        this.pool.schedule(message);
        this.pool.advance(Infinity);
      }
    }

    /** Rates stand in as note numbers, so a test can read them back. */
    noteMessage({ midiNote, velocity, secondsFromNow = 0, glide }: any) {
      return {
        timestamp: secondsFromNow,
        midiNote,
        playbackRate: midiNote,
        velocity,
        glideTime: glide.seconds,
        glideFromNote: glide.fromMidiNote,
        glideFrom: glide.fromMidiNote,
        glideSeconds: glide.seconds,
      };
    }

    trigger({ midiNote }: { midiNote: number }) {
      this.poolVoice.start(0, 0, { midiNote });
      this.#receive({ type: 'voice:started', midiNote });
      return midiNote;
    }

    stop() {
      if (this.state === VoiceState.AVAILABLE) return this;
      this.poolVoice.stop(0);
      this.#emit('voice:stopped');
      this.state = VoiceState.AVAILABLE;
      this.midiNote = null;
      return this;
    }

    setLoopEnabled = vi.fn();

    dispose() {}
  }

  return {
    createSampleVoices: async (numVoices: number) => {
      const pool = new VoicePool();
      return Array.from({ length: numVoices }, () => new TestVoice(pool));
    },
  };
});

describe('SamplePlayer sustain with the real voice pool', () => {
  let player: SamplePlayer | undefined;

  afterEach(() => {
    player?.dispose();
    player = undefined;
    vi.unstubAllGlobals();
  });

  async function setupPlayer() {
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
    const context = Object.assign(new EventTarget(), { currentTime: 0 }) as AudioContext;
    const pool = await setup();
    const noteOff = vi.fn();
    const releaseAll = vi.fn();
    const setPitch = vi.fn();
    player = new SamplePlayer({ context });
    const playerPool = await initTestPlayer(
      player,
      {
        allVoices: pool.allVoices,
        onMessage: pool.onMessage.bind(pool),
        noteOn: pool.noteOn.bind(pool),
        noteOff: pool.noteOff.bind(pool),
        allNotesOff: pool.allNotesOff.bind(pool),
        dispose: pool.dispose.bind(pool),
      },
      { noteOn() {}, noteOff, releaseAll, getFeedback: () => ({ setPitch }) } as never,
    );
    Object.defineProperty(playerPool, 'legato', {
      get: () => pool.legato,
      set: (settings) => {
        pool.legato = settings;
      },
    });
    const upstream = vi.fn();
    player.onMessage('note:off', upstream);
    return { player, pool, noteOff, releaseAll, setPitch, upstream };
  }

  it('releases only deferred keys and drains multiple pitches and counts once', async () => {
    const { player, pool, noteOff, releaseAll, upstream } = await setupPlayer();
    player.play(60);
    player.play(64);
    player.play(67);
    player.setSustainPedal(true);
    expect(player.holdEnabled).toBe(false);
    player.release(64, 10);
    player.release(64);
    player.release(67);
    expect(pool.playingVoicesCount).toBe(3);
    expect(noteOff).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();

    player.setSustainPedal(false);
    expect(pool.allVoices.find((voice) => voice.midiNote === 60)?.state).toBe(VoiceState.PLAYING);
    expect(pool.playingVoicesCount).toBe(1);
    expect(releaseAll).not.toHaveBeenCalled();
    expect(noteOff.mock.calls).toEqual([[64], [64], [67]]);
    expect(upstream.mock.calls.map(([message]) => message.midiNote)).toEqual([64, 64, 67]);
    player.setSustainPedal(false);
    expect(noteOff).toHaveBeenCalledTimes(3);
    player.release(60);
    expect(pool.playingVoicesCount).toBe(0);
  });

  it('returns a legato voice to a still-held key on pedal-up', async () => {
    const { player, pool, setPitch } = await setupPlayer();
    player.setLegato({ mode: 'always' });
    player.play(60);
    player.play(64);
    player.setSustainPedal(true);
    player.release(64);
    expect(pool.allVoices[0].midiNote).toBe(64);
    player.setSustainPedal(false);
    expect(pool.allVoices[0].state).toBe(VoiceState.PLAYING);
    expect(pool.allVoices[0].midiNote).toBe(60);
    expect(setPitch).toHaveBeenLastCalledWith(60, 0, 0, 0);
  });

  it.each(['hold', 'lock'] as const)('keeps explicit %s independent of the pedal', async (mode) => {
    const { player, pool, noteOff, releaseAll } = await setupPlayer();
    const setHold = (enabled: boolean) =>
      mode === 'hold' ? player.setHoldEnabled(enabled) : player.setHoldLocked(enabled);
    player.play(60);
    player.setSustainPedal(true);
    player.release(60);
    setHold(true);
    player.setSustainPedal(false);
    expect(pool.playingVoicesCount).toBe(1);
    expect(noteOff).not.toHaveBeenCalled();
    expect(releaseAll).not.toHaveBeenCalled();
    setHold(false);
    expect(pool.playingVoicesCount).toBe(0);
    expect(releaseAll).toHaveBeenCalledOnce();

    // Disabling explicit hold while the pedal stays down keeps release-all semantics.
    setHold(true);
    player.setSustainPedal(true);
    player.play(64);
    player.release(64);
    setHold(false);
    expect(pool.playingVoicesCount).toBe(0);
    player.play(67);
    player.release(67);
    expect(pool.playingVoicesCount).toBe(1);
    player.setSustainPedal(false);
    expect(pool.playingVoicesCount).toBe(0);
    expect(noteOff.mock.calls).toEqual([[67]]);
  });

  it('preserves ordinary pedal looping and a loop enabled before pedal-down', async () => {
    const { player, pool } = await setupPlayer();
    const loop = vi.spyOn(pool.allVoices[0], 'setLoopEnabled');
    player.setSustainPedal(true);
    expect(loop).toHaveBeenLastCalledWith(true);
    player.setSustainPedal(false);
    expect(loop).toHaveBeenLastCalledWith(false);
    player.setLoopEnabled(true);
    loop.mockClear();
    player.setSustainPedal(true);
    player.setSustainPedal(false);
    expect(loop).not.toHaveBeenCalled();
  });
});

async function setup(polyphony = 3) {
  const { SampleVoicePool } = await import('./SampleVoicePool');
  const pool = new SampleVoicePool({ currentTime: 0 } as AudioContext, polyphony);
  await pool.init();
  return pool;
}

describe('SampleVoicePool', () => {
  it('returns to the most recent held note without retriggering', async () => {
    const pool = await setup();
    pool.legato = { mode: 'always' };
    const voice = pool.allVoices[0];
    const retuned = vi.fn();
    pool.onMessage('voice:retuned', retuned);
    pool.noteOn(0);
    pool.noteOn(62);
    pool.noteOn(64);
    pool.noteOn(65, 20, 0, 0.4);
    pool.noteOff(62);
    expect(voice.midiNote).toBe(65);

    pool.noteOff(65, 0.2);
    expect(retuned).toHaveBeenLastCalledWith(
      expect.objectContaining({ midiNote: 64, timestamp: 0.2, glideTime: 0.4, fallback: true }),
    );
    expect(voice.midiNote).toBe(64);
    pool.noteOff(64);
    expect(voice.midiNote).toBe(0);
    pool.legato = { mode: 'off' };
    pool.noteOn(72, 100, 0, 0.2);
    // The next note glides from the note the voice fell back to.
    expect(engineOf(pool.allVoices[1]).start.mock.lastCall?.[2]).toMatchObject({
      glideFrom: 0,
      glideSeconds: 0.2,
    });
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(engineOf(voice).start).toHaveBeenCalledOnce();
    pool.noteOff(0);
    expect(voice.state).toBe(VoiceState.RELEASING);
    pool.dispose();
  });

  it('keeps held-note stacks separate for independent voices', async () => {
    const pool = await setup();
    const [first, second] = pool.allVoices;
    pool.noteOn(60);
    pool.noteOn(72);
    pool.legato = { mode: 'always', interval: [-6, 6] };
    pool.noteOn(65);
    pool.noteOn(77);

    pool.noteOff(65);
    expect(first.midiNote).toBe(60);
    expect(second.midiNote).toBe(77);
    pool.noteOff(72);
    pool.noteOff(77);
    expect(second.state).toBe(VoiceState.RELEASING);
    expect(first.state).toBe(VoiceState.PLAYING);
    pool.dispose();
  });

  it('removes a reassigned note from the earlier voice stack', async () => {
    const pool = await setup();
    pool.legato = { mode: 'always', interval: [1, 12] };
    pool.noteOn(60);
    pool.noteOn(64);
    pool.noteOn(60);
    pool.noteOff(64);
    expect(pool.allVoices[0].state).toBe(VoiceState.RELEASING);
    expect(pool.allVoices[1].midiNote).toBe(60);
    expect(pool.allVoices[1].state).toBe(VoiceState.PLAYING);
    pool.dispose();
  });

  it('glides only legato notes in legato glide mode', async () => {
    const pool = await setup();
    const [first, second] = pool.allVoices;
    pool.legato = { mode: 'always', interval: [-12, 12], glide: 'legato' };
    const started = vi.fn();
    const retuned = vi.fn();
    pool.onMessage('voice:started', started);
    pool.onMessage('voice:retuned', retuned);
    pool.noteOn(60, 100, 0, 0.3);
    pool.noteOn(64, 100, 0, 0.3);
    expect(retuned).toHaveBeenLastCalledWith(
      expect.objectContaining({ midiNote: 64, glideTime: 0.3, fallback: false }),
    );
    pool.noteOn(90, 100, 0, 0.3);
    expect(started).toHaveBeenLastCalledWith(
      expect.objectContaining({ midiNote: 90, glideTime: 0 }),
    );
    expect(engineOf(second).start.mock.lastCall?.[2]).not.toHaveProperty('glideFrom');
    expect(first.midiNote).toBe(64);

    pool.legato = { mode: 'off' };
    pool.noteOn(50, 100, 0, 0.3);
    expect(started).toHaveBeenLastCalledWith(
      expect.objectContaining({ midiNote: 50, glideTime: 0.3 }),
    );
    pool.dispose();
  });

  it('retriggers when the signed interval is outside the legato range', async () => {
    const pool = await setup();
    const [first, second] = pool.allVoices;
    pool.legato = { mode: 'always', interval: [1, 12] };
    pool.noteOn(60);
    pool.noteOn(64);
    pool.noteOn(62);
    expect(first.midiNote).toBe(64);
    expect(second.midiNote).toBe(62);
    pool.noteOn(77);
    expect(pool.allVoices[2].midiNote).toBe(77);
    pool.dispose();
  });

  it.each(['stop', 'allNotesOff'] as const)(
    'starts a fresh held-note stack after %s',
    async (action) => {
      const pool = await setup(1);
      const voice = pool.allVoices[0];
      pool.legato = { mode: 'always' };
      pool.noteOn(60);
      pool.noteOn(64);
      if (action === 'stop') voice.stop();
      else pool.allNotesOff();

      pool.noteOn(67);
      pool.noteOn(67);
      pool.noteOff(67);
      expect(voice.state).toBe(VoiceState.RELEASING);
      pool.dispose();
    },
  );

  it('retunes only a voice in a pitch loop and releases after all its notes are off', async () => {
    const pool = await setup();
    const [first, second] = pool.allVoices;
    pool.noteOn(60);
    pool.noteOn(62);
    vi.spyOn((second as any).poolVoice, 'isInPitchLoop', 'get').mockReturnValue(true);
    pool.legato = { mode: 'pitchLoop' };

    pool.noteOn(65, 20, 0.2, 0.3);
    expect(engineOf(second).setNoteRate).toHaveBeenCalledWith(0.2, 65, 0.3);
    expect(engineOf(second).start).toHaveBeenCalledOnce();
    expect(engineOf(second).stop).not.toHaveBeenCalled();
    expect(first.midiNote).toBe(60);
    expect(pool.playingVoicesCount).toBe(2);
    pool.noteOff(62);
    expect(second.state).toBe(VoiceState.PLAYING);
    pool.noteOff(65);
    expect(second.state).toBe(VoiceState.RELEASING);

    pool.legato = { mode: 'always' };
    pool.noteOff(60);
    pool.noteOn(67);
    expect(pool.allVoices[2].midiNote).toBe(67);
    pool.dispose();
  });

  it('uses an available voice, then steals the oldest releasing and playing voices', async () => {
    const pool = await setup();
    const [first, second, third] = pool.allVoices;

    pool.noteOn(60);
    pool.noteOn(62);
    pool.noteOn(64);
    pool.noteOff(62);

    pool.noteOn(65);
    expect(engineOf(second).stop).toHaveBeenCalledOnce();
    expect(second.midiNote).toBe(65);

    pool.noteOn(67);
    expect(engineOf(first).stop).toHaveBeenCalledOnce();
    expect(pool.allVoices.map((voice) => voice.midiNote)).toEqual([67, 65, 64]);
    expect(third.state).toBe(VoiceState.PLAYING);
    expect(pool.playingVoicesCount).toBe(3);

    pool.dispose();
  });

  it('releases an earlier same-note voice and routes note-off to its replacement', async () => {
    const pool = await setup();
    const [first, second] = pool.allVoices;
    pool.noteOn(0);
    pool.noteOn(0, 100, 0.2);

    expect(engineOf(first).release).toHaveBeenCalledWith(0.2);
    expect(first.state).toBe(VoiceState.RELEASING);
    expect(second.state).toBe(VoiceState.PLAYING);

    pool.noteOff(0, 0.1);
    expect(engineOf(second).release).toHaveBeenCalledWith(0.1);
    expect(pool.playingVoicesCount).toBe(0);
    expect(pool.releasingVoicesCount).toBe(2);

    pool.dispose();
  });

  it('releases every playing voice that owns the note', async () => {
    const pool = await setup();
    const [first, second, other] = pool.allVoices;
    first.trigger({ midiNote: 72, velocity: 100 });
    second.trigger({ midiNote: 72, velocity: 100 });
    other.trigger({ midiNote: 73, velocity: 100 });

    pool.noteOff(72);

    expect(first.state).toBe(VoiceState.RELEASING);
    expect(second.state).toBe(VoiceState.RELEASING);
    expect(other.state).toBe(VoiceState.PLAYING);
    expect(pool.releasingVoicesCount).toBe(2);

    pool.dispose();
  });

  it('targets active and inactive voices from their current state', async () => {
    const pool = await setup();
    const [playing, releasing, available] = pool.allVoices;
    pool.noteOn(60);
    pool.noteOn(62);
    pool.noteOff(62);

    const active: typeof pool.allVoices = [];
    const inactive: typeof pool.allVoices = [];
    const note: typeof pool.allVoices = [];
    pool.applyToActiveVoices((voice) => active.push(voice));
    pool.applyToInactiveVoices((voice) => inactive.push(voice));
    pool.applyToActiveNote(62, (voice) => note.push(voice));

    expect(active).toEqual([playing, releasing]);
    expect(inactive).toEqual([available]);
    expect(note).toEqual([releasing]);

    pool.dispose();
  });
});
