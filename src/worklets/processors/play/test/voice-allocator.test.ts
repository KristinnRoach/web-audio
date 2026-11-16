import { describe, expect, it } from 'vite-plus/test';
import { VoiceAllocator } from '../engine/voice-allocator.js';

const voice = (state = 'AVAILABLE', midiNote: number | null = null, triggerTimestamp = -1) => ({
  state,
  midiNote,
  triggerTimestamp,
  isInPitchLoop: false,
});
const types = (actions: { type: string }[]) => actions.map((action) => action.type);

describe('VoiceAllocator', () => {
  it('takes a free voice, then the oldest release tail, then the oldest held note', () => {
    const allocator = new VoiceAllocator();
    const [a, b, c] = [voice('PLAYING', 60, 1), voice('RELEASING', 62, 2), voice()];
    allocator.voices = [a, b, c];

    expect(allocator.noteOn(64)!.actions).toEqual([
      { type: 'start', voice: c, midiNote: 64, glideTime: 0 },
    ]);
    Object.assign(c, { state: 'PLAYING', triggerTimestamp: 3 });
    expect(allocator.noteOn(65)!.actions.slice(0, 2)).toMatchObject([
      { type: 'steal', voice: b },
      { type: 'start', voice: b },
    ]);
    Object.assign(b, { state: 'PLAYING', triggerTimestamp: 4 });
    expect(allocator.noteOn(66)!.actions[0]).toEqual({ type: 'steal', voice: a });
  });

  it('releases other voices holding a retriggered note', () => {
    const allocator = new VoiceAllocator();
    const [a, b] = [voice('PLAYING', 60, 1), voice()];
    allocator.voices = [a, b];
    expect(types(allocator.noteOn(60)!.actions)).toEqual(['start', 'release']);
  });

  it('retunes in legato and falls back to the earlier held note on note-off', () => {
    const allocator = new VoiceAllocator();
    allocator.legato = { mode: 'always' };
    const a = voice();
    allocator.voices = [a, voice()];

    allocator.noteOn(60, 0.1)!.commit();
    Object.assign(a, { state: 'PLAYING', midiNote: 60 });
    const second = allocator.noteOn(64, 0.1)!;
    expect(second.retuned).toBe(true);
    expect(second.actions).toEqual([{ type: 'retune', voice: a, midiNote: 64, glideTime: 0.1 }]);
    second.commit();
    a.midiNote = 64;

    expect(allocator.noteOff(64)).toEqual([
      { type: 'retune', voice: a, midiNote: 60, glideTime: 0.1 },
    ]);
    a.midiNote = 60;
    expect(allocator.noteOff(60)).toEqual([{ type: 'release', voice: a }]);
  });

  it('retunes only inside the signed legato interval', () => {
    const allocator = new VoiceAllocator();
    allocator.legato = { mode: 'always', interval: [-2, 2] };
    const a = voice('PLAYING', 60, 1);
    allocator.voices = [a, voice()];

    expect(allocator.noteOn(62)!.retuned).toBe(true);
    expect(allocator.noteOn(58)!.retuned).toBe(true);
    expect(allocator.noteOn(63)!.retuned).toBe(false);
    expect(allocator.noteOn(57)!.retuned).toBe(false);
  });

  it('glides only retuned notes in legato glide mode', () => {
    const allocator = new VoiceAllocator();
    allocator.legato = { mode: 'always', interval: [0, 2], glide: 'legato' };
    allocator.voices = [voice('PLAYING', 60, 1), voice()];

    expect(allocator.noteOn(62, 0.1)!.glideTime).toBe(0.1);
    expect(allocator.noteOn(72, 0.1)!.actions[0]).toMatchObject({ type: 'start', glideTime: 0 });
  });

  it('retunes in pitchLoop mode only a voice that is in a pitch loop', () => {
    const allocator = new VoiceAllocator();
    allocator.legato = { mode: 'pitchLoop' };
    const a = voice('PLAYING', 60, 1);
    allocator.voices = [a, voice()];

    expect(allocator.noteOn(62)!.retuned).toBe(false);
    a.isInPitchLoop = true;
    expect(allocator.noteOn(62)!.retuned).toBe(true);
  });

  it('keeps a held-note stack per voice and moves a reassigned note out of the earlier one', () => {
    const allocator = new VoiceAllocator();
    allocator.legato = { mode: 'always', interval: [0, 2] };
    const [a, b, c] = [voice(), voice(), voice()];
    allocator.voices = [a, b, c];
    const play = (midiNote: number) => {
      const decision = allocator.noteOn(midiNote)!;
      const { voice: target } = decision.actions.find(({ type }) => type !== 'release')!;
      Object.assign(target, { state: 'PLAYING', midiNote });
      decision.commit();
      return target;
    };

    expect(play(60)).toBe(a);
    expect(play(72)).toBe(b);
    expect(play(62)).toBe(a);
    expect(play(74)).toBe(b);
    // Each voice falls back within its own phrase.
    expect(allocator.noteOff(74)).toEqual([
      { type: 'retune', voice: b, midiNote: 72, glideTime: 0 },
    ]);

    // 60 is out of a's interval, so it starts on c and leaves a's stack.
    expect(play(60)).toBe(c);
    expect(allocator.noteOff(62)).toEqual([{ type: 'release', voice: a }]);
  });

  it('uses a swapped selection policy', () => {
    const allocator = new VoiceAllocator((voices: unknown[]) => voices.at(-1));
    const last = voice();
    allocator.voices = [voice(), last];
    expect(allocator.noteOn(60)!.actions[0].voice).toBe(last);
  });
});
