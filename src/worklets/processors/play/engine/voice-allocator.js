/**
 * Decides which voices a note event touches. It reads voice state and
 * returns actions for the owner to apply in order, so the same code can run on
 * the main thread (today) or inside the processor.
 *
 * A voice is anything with `state` ('AVAILABLE' | 'PLAYING' | 'RELEASING'),
 * `midiNote`, `triggerTimestamp` and `isInPitchLoop`.
 *
 * Actions: `steal` (stop, then the voice is free), `start`, `retune` (pitch
 * moves, source and envelopes keep running) and `release`. One event may
 * return several, which is the seam for rotation and voice stacking.
 */

const oldest = (voices, state) =>
  voices.reduce(
    (found, voice) =>
      voice.state === state && (!found || voice.triggerTimestamp < found.triggerTimestamp)
        ? voice
        : found,
    undefined,
  );

/** Default policy: a free voice, else the oldest release tail, else the oldest held note. */
export const firstFreeThenOldest = (voices) =>
  voices.find((voice) => voice.state === 'AVAILABLE') ??
  oldest(voices, 'RELEASING') ??
  oldest(voices, 'PLAYING');

export class VoiceAllocator {
  voices = [];
  /** @type {{ mode: 'off' | 'always' | 'pitchLoop', interval?: readonly [number, number], glide?: 'always' | 'legato' }} */
  legato = { mode: 'off' };
  /** Swap to change which voice a new note takes, e.g. rotation. */
  selectVoice;

  // Last-note priority stays local to each voice's legato phrase.
  #held = new Map();

  constructor(selectVoice = firstFreeThenOldest) {
    this.selectVoice = selectVoice;
  }

  #canLegato(voice, midiNote) {
    const { mode, interval } = this.legato;
    if (mode === 'off' || voice.state !== 'PLAYING' || voice.midiNote === null) return false;
    if (mode === 'pitchLoop' && !voice.isInPitchLoop) return false;
    const offset = midiNote - voice.midiNote;
    return !interval || (offset >= interval[0] && offset <= interval[1]);
  }

  /** Apply actions in order; commit after start/retune succeeds, before releases. Null if no voice can be selected. */
  noteOn(midiNote, glideTime = 0) {
    const legatoVoice = this.voices.find((voice) => this.#canLegato(voice, midiNote));
    const voice = legatoVoice ?? this.selectVoice(this.voices);
    if (!voice) return null;
    if (!legatoVoice && this.legato.glide === 'legato') glideTime = 0;

    const actions = [];
    if (legatoVoice) actions.push({ type: 'retune', voice, midiNote, glideTime });
    else {
      if (voice.state !== 'AVAILABLE') actions.push({ type: 'steal', voice });
      actions.push({ type: 'start', voice, midiNote, glideTime });
    }

    for (const other of this.voices) {
      if (other !== voice && other.state === 'PLAYING' && other.midiNote === midiNote) {
        actions.push({ type: 'release', voice: other });
      }
    }
    return {
      actions,
      glideTime,
      retuned: !!legatoVoice,
      // Commit only after start/retune succeeds; a rejected note must not change held keys.
      commit: () => {
        // Stacks are only read on PLAYING voices, and a start begins a fresh one.
        const notes = legatoVoice ? (this.#held.get(voice)?.notes ?? []) : [];
        this.#held.set(voice, {
          notes: [...notes.filter((note) => note !== midiNote), midiNote],
          glideTime,
        });
        for (const other of this.voices) {
          if (other === voice) continue;
          const held = this.#held.get(other);
          if (held) held.notes = held.notes.filter((note) => note !== midiNote);
        }
      },
    };
  }

  /** A legato voice falls back to its earlier held note instead of releasing. */
  noteOff(midiNote) {
    const actions = [];
    for (const voice of this.voices) {
      if (voice.state !== 'PLAYING') continue;
      const held = this.#held.get(voice);
      if (held) held.notes = held.notes.filter((note) => note !== midiNote);
      if (voice.midiNote !== midiNote) continue;

      const previousNote = held?.notes.at(-1);
      if (previousNote !== undefined) {
        actions.push({ type: 'retune', voice, midiNote: previousNote, glideTime: held.glideTime });
      } else actions.push({ type: 'release', voice });
    }
    return actions;
  }

  clear() {
    this.#held.clear();
  }
}
