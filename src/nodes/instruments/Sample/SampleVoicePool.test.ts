import { describe, expect, it, vi } from 'vite-plus/test';
import type { Message, MessageHandler } from '../../../events';
import { VoiceState } from '../VoiceState';

const fake = vi.hoisted(() => ({ triggerTimestamp: 0 }));

vi.mock('./createSampleVoice', () => {
  class TestVoice {
    state: VoiceState = VoiceState.AVAILABLE;
    midiNote: number | null = null;
    triggerTimestamp = -1;
    handlers = new Map<string, Set<MessageHandler<Message>>>();

    onMessage(type: string, handler: MessageHandler<Message>) {
      const handlers = this.handlers.get(type) ?? new Set();
      handlers.add(handler);
      this.handlers.set(type, handlers);
      return () => handlers.delete(handler);
    }

    #emit(type: string, midiNote = this.midiNote) {
      this.handlers
        .get(type)
        ?.forEach((handler) => handler({ type, senderId: 'test', voice: this, midiNote }));
    }

    trigger({ midiNote }: { midiNote: number }): number | null {
      if (this.state !== VoiceState.AVAILABLE) return null;
      this.state = VoiceState.PLAYING;
      this.midiNote = midiNote;
      this.triggerTimestamp = ++fake.triggerTimestamp;
      this.#emit('voice:started');
      return midiNote;
    }

    release({ releaseTime = 1 }: { releaseTime?: number } = {}) {
      if (releaseTime <= 0) return this.stop();
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

    pool.noteOff(0, 0.1, 0.4);
    expect(releaseSecond).toHaveBeenCalledWith({ secondsFromNow: 0.1, releaseTime: 0.4 });
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
