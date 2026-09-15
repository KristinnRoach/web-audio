# Voice addressing — design record

Root cause of the occasional stuck note, plus the sustain-pedal behaviour it masks. Proposal only; nothing implemented yet.

## The bug

`SampleVoicePool` keys playing voices with `Map<MidiValue, SampleVoice>` (`#playingMidiVoiceMap`). The real relationship is one note to _many_ sounding voices, so the map cannot represent it.

`noteOn` (`SampleVoicePool.ts:258`) never consults the map and never steals: it allocates a fresh voice and overwrites the entry. Strike the same note twice without an intervening `noteOff` and the first voice is still sounding but no longer addressable. `noteOff` (`:289`) resolves only the newest voice; the orphan's `voice:stopped` cleanup then finds the map pointing elsewhere and no-ops (`:147`).

An orphaned one-shot ends by itself. An orphaned **looping** voice never does.

Reachable on `main` today:

1. Sustain pedal down: `setSustainPedal` calls both `setHoldEnabled(true)` and `setLoopEnabled(true)` (`SamplePlayer.ts:840`)
2. Strike C: voice A, looping
3. Release C: `release()` early-returns on `holdEnabled` (`:675`), no note-off
4. Strike C again: voice B allocated, map entry overwritten, **A orphaned and looping**
5. Pedal up: `releaseAll(0.1)` reaches `allNotesOff`, which iterates `#allVoices` directly and does catch A

Step 5 is why it is intermittent. Any path reaching `voicePool.noteOff` instead of `allNotesOff` leaves A running indefinitely.

## Fix

Invert the ownership. Voices are the primary entity and already know their own note, so address them by scan and delete the index:

```ts
noteOff(midiNote, secondsFromNow = 0, releaseTime?) {
  for (const voice of this.#allVoices) {
    if (voice.midiNote === midiNote && voice.state === VoiceState.PLAYING) {
      voice.release({ secondsFromNow, releaseTime });
    }
  }
}
```

Polyphony is 8–64, so the scan is free. This removes `#playingMidiVoiceMap` along with the stale-entry guards at `:120` and `:147`, which exist only to paper over the desync. Keeping an index instead would require `Map<midi, Set<voice>>`.

MIDI note-off names a pitch and nothing else — there is no voice identity in the protocol, which is what MPE's per-channel allocation exists to solve. Addressing by note is correct; one-voice-per-note is the wrong arity.

Out of scope, noted while reading: at max polyphony `noteOn` refuses and logs (`:264`) rather than stealing the oldest voice. Audible as dropped notes under dense playing.

## Reconcile before implementing

`SampleVoicePool.ts` is byte-identical on `main` and `post-filter-cutoff-env`, so this fix branches cleanly off either. The follow-up below does not.

`InstrumentBus` on `main` exposes `noteOn` only. `noteOff`, `releaseAll`, `#heldNotes` and `#lpfEnvScheduler` all arrive on `post-filter-cutoff-env`. Consequences:

- On `main`, `SamplePlayer.play()` calls `outBus.noteOn` with no counterpart anywhere. Unbalanced, and harmless only because nothing counts yet.
- On `post-filter-cutoff-env`, `#heldNotes` is a refcount whose `size === 0` gates the post-FX filter envelope release. Every `outBus.noteOn` must get exactly one `outBus.noteOff` or the envelope never releases.
- `SamplePlayer.release()` therefore differs between the two branches.

The follow-up is written against the `post-filter-cutoff-env` shape and should land on top of it, not on `main`.

## Follow-up: sustain pedal should not be hold

`#sustainedNotes` (`SamplePlayer.ts:157`) is a deferred-release queue that is currently unreachable. Pedal down calls `setHoldEnabled(true)` (`:851`), so `release()` returns at the `holdEnabled` guard (`:675`) before it can ever reach the `.add` at `:680`. Both branches of the `#holdLocked` check exit early, so the set is always empty and the pedal-up drain loop at `:855` iterates nothing.

Net effect: pedal-up runs `releaseAll`, which cuts **every** note including keys still physically held. On a real piano, and under MIDI CC64, lifting the pedal never damps a key that is still down.

Three edits, all in `SamplePlayer`, roughly break-even on line count:

1. Extract the note-off sequence into `#endNote(note)`. That body is already duplicated between the tail of `release()` and the pedal drain loop.
2. Drop `setHoldEnabled(pressed)` from `setSustainPedal`. This alone makes the queue reachable; `release()` then works as written. Hold stays the bigger hammer and still wins the guard when explicitly enabled.
3. In `play()`, flush a pending sustained note before re-triggering, so each `outBus.noteOn` keeps its partner. Unnecessary once the voice-pool fix lands, since a scan-based `noteOff` releases both voices correctly on its own.

Nothing outside `SamplePlayer` reads `holdEnabled` or `hold:enabled`, so the only observable API change is that the pedal stops lighting the hold state.

Loop-on-pedal (`:845`) is untouched and remains a separate question.

**Tonal change, needs an ear test.** Pedal-up currently forces a 0.1s release on every note via `releaseAll(0.1)`. The new path uses `voicePool.noteOff`, which leaves `releaseTime` undefined so each voice uses its own envelope release (`SampleVoicePool.ts:289` vs `:300`). More correct, probably longer, definitely different.
