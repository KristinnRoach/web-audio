import { describe, expect, it, vi } from 'vite-plus/test';
import type { Message, MessageHandler } from '../../../events';
import { VoiceState } from '../VoiceState';

const fake = vi.hoisted(() => ({ triggerTimestamp: 0 }));

vi.mock('./createSampleVoice', () => {
  class TestVoice {
    state: VoiceState = VoiceState.AVAILABLE;
    midiNote: number | null = null;
    triggerTimestamp = -1;
    get isInPitchLoop() {
      return false;
    }
    handlers = new Map<string, Set<MessageHandler<Message>>>();

    onMessage(type: string, handler: MessageHandler<Message>) {
      const handlers = this.handlers.get(type) ?? new Set();
      handlers.add(handler);
      this.handlers.set(type, handlers);
      return () => handlers.delete(handler);
    }

    #emit(type: string, midiNote = this.midiNote) {
      this.handlers.get(type)?.forEach((handler) => handler({ type, senderId: 'test', midiNote }));
    }

    trigger({ midiNote }: { midiNote: number }): number | null {
      if (this.state !== VoiceState.AVAILABLE) return null;
      this.state = VoiceState.PLAYING;
      this.midiNote = midiNote;
      this.triggerTimestamp = ++fake.triggerTimestamp;
      this.#emit('voice:started');
      return midiNote;
    }

    retune(midiNote: number) {
      this.midiNote = midiNote;
      return midiNote;
    }

    release() {
      if (this.state !== VoiceState.PLAYING) return this;
      this.state = VoiceState.RELEASING;
      this.#emit('voice:releasing');
      return this;
    }

    stop() {
      if (this.state === VoiceState.AVAILABLE) return this;
      const midiNote = this.midiNote;
      this.state = VoiceState.AVAILABLE;
      this.midiNote = null;
      this.#emit('voice:stopped', midiNote);
      return this;
    }

    dispose() {}
  }

  return {
    createSampleVoices: async (numVoices: number) =>
      Array.from({ length: numVoices }, () => new TestVoice()),
  };
});

async function setup(polyphony = 3) {
  fake.triggerTimestamp = 0;
  const { SampleVoicePool } = await import('./SampleVoicePool');
  const pool = new SampleVoicePool({} as AudioContext, polyphony);
  await pool.init();
  return pool;
}

describe('SampleVoicePool', () => {
  it('returns to the most recent held note without retriggering', async () => {
    const pool = await setup();
    pool.legato = { mode: 'always' };
    const voice = pool.allVoices[0];
    const retrigger = vi.spyOn(voice, 'trigger');
    const retune = vi.spyOn(voice, 'retune');
    pool.noteOn(0);
    pool.noteOn(62);
    pool.noteOn(64);
    pool.noteOn(65, 20, 0, 0.4);
    pool.noteOff(62);
    expect(voice.midiNote).toBe(65);

    expect(pool.noteOff(65, 0.2)).toEqual({ midiNote: 64, glideTime: 0.4 });
    expect(voice.midiNote).toBe(64);
    expect(retune).toHaveBeenLastCalledWith(64, 0.2, 0.4);
    pool.noteOff(64);
    expect(voice.midiNote).toBe(0);
    const nextTrigger = vi.spyOn(pool.allVoices[1], 'trigger');
    pool.legato = { mode: 'off' };
    pool.noteOn(72, 100, 0, 0.2);
    expect(nextTrigger.mock.calls[0][0].glide).toEqual({ fromMidiNote: 0, seconds: 0.2 });
    expect(voice.state).toBe(VoiceState.PLAYING);
    expect(retrigger).toHaveBeenCalledOnce();
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
    const trigger = vi.spyOn(second, 'trigger');
    pool.noteOn(60, 100, 0, 0.3);
    expect(pool.noteOn(64, 100, 0, 0.3)).toEqual({ midiNote: 64, glideTime: 0.3, retuned: true });
    expect(pool.noteOn(90, 100, 0, 0.3)).toEqual({ midiNote: 90, glideTime: 0, retuned: false });
    expect(trigger.mock.calls[0][0].glide).toEqual({ fromMidiNote: 64, seconds: 0 });
    expect(first.midiNote).toBe(64);

    pool.legato = { mode: 'off' };
    expect(pool.noteOn(50, 100, 0, 0.3)?.glideTime).toBe(0.3);
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
    vi.spyOn(second, 'isInPitchLoop', 'get').mockReturnValue(true);
    pool.legato = { mode: 'pitchLoop' };
    const retrigger = vi.spyOn(second, 'trigger');
    const retune = vi.spyOn(second, 'retune');
    const stop = vi.spyOn(second, 'stop');

    expect(pool.noteOn(65, 20, 0.2, 0.3)).toEqual({ midiNote: 65, glideTime: 0.3, retuned: true });
    expect(retune).toHaveBeenCalledWith(65, 0.2, 0.3);
    expect(retrigger).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
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

    const stopSecond = vi.spyOn(second, 'stop');
    pool.noteOn(65);
    expect(stopSecond).toHaveBeenCalledOnce();
    expect(second.midiNote).toBe(65);

    const stopFirst = vi.spyOn(first, 'stop');
    pool.noteOn(67);
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(pool.allVoices.map((voice) => voice.midiNote)).toEqual([67, 65, 64]);
    expect(third.state).toBe(VoiceState.PLAYING);
    expect(pool.playingVoicesCount).toBe(3);

    pool.dispose();
  });

  it('releases an earlier same-note voice and routes note-off to its replacement', async () => {
    const pool = await setup();
    const [first, second] = pool.allVoices;
    const releaseFirst = vi.spyOn(first, 'release');
    const releaseSecond = vi.spyOn(second, 'release');

    pool.noteOn(0);
    pool.noteOn(0, 100, 0.2);

    expect(releaseFirst).toHaveBeenCalledWith({ secondsFromNow: 0.2 });
    expect(first.state).toBe(VoiceState.RELEASING);
    expect(second.state).toBe(VoiceState.PLAYING);

    pool.noteOff(0, 0.1);
    expect(releaseSecond).toHaveBeenCalledWith({ secondsFromNow: 0.1 });
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
