# Voice addressing — design record

One fact, several representations. Every desync bug in this area is two of them disagreeing.

## Root cause

A voice's state is owned by `SampleVoice.#state` and written synchronously at the call sites: `trigger()` to PLAYING, `release()` to RELEASING, `stop()` to AVAILABLE.

`SampleVoicePool` keeps four copies of that fact — `#available`, `#playing`, `#releasing`, and `#playingMidiVoiceMap` — and rebuilds them from worklet messages. Those messages lag by a round trip, so the pool's view is a stale copy of state the voice already knows.

The map has a second problem. It is keyed by note but invalidated per voice, and `Map<note, voice>` cannot hold the several voices a note can own. `allocate()` reuses a RELEASING voice without dropping its old key, so one voice ends up under two notes.

## Done: the voice layer

`VoiceState` is three states — AVAILABLE, PLAYING, RELEASING. Readiness is tracked separately by `#hasLoadedAudio`, since a voice can be reloaded while sounding.

Worklet messages no longer write `#state`; they are advisory. `voice:stopped` ignores an echo that arrives after a retrigger, which is what used to let a late message delete the live map entry for a note and leave it sounding.

## Remaining: the pool

Keep `#allVoices`. Delete the three Sets and the map, and derive everything by scan — polyphony is 8–64.

- counts: filter `#allVoices` on `voice.state`
- `noteOff(note)`: release every voice where `voice.midiNote === note` and state is PLAYING
- `allocate()`: first AVAILABLE, else oldest RELEASING, else oldest PLAYING

That last step is missing today — `noteOn` refuses and logs at max polyphony rather than stealing. Dropped notes are the more audible failure.

The pool's message handlers then serve only `#updateVoiceGains` and upstream notification.

Two cleanups while in there: `SampleVoice.isActive` and `setLoopEnabled` both infer "playing" from `#midiNote !== null`, which is true for an AVAILABLE voice until the stop echo lands. Both should read `#state`. `currMidiNote` and `midiNote` are duplicate getters.

`SampleVoicePool.test.ts` reads `assignedVoicesMidiMap` in 13 places and asserts map identity rather than audible behaviour. Rewriting it against `noteOn` / `noteOff` / `state` is most of the work.

## Reconcile before the follow-up

`SampleVoicePool.ts` is identical on `main` and `post-filter-cutoff-env`, so the pool work branches off either.

The pedal follow-up does not. `InstrumentBus` on `main` has `noteOn` only; `noteOff`, `releaseAll`, `#heldNotes` and `#lpfEnvScheduler` arrive on `post-filter-cutoff-env`, where `#heldNotes` gates the post-FX filter envelope release. `SamplePlayer.release()` differs between the two. The follow-up should land on top of that branch.

## Follow-up: sustain pedal should not be hold

`#sustainedNotes` is a deferred-release queue that never fills. Pedal down calls `setHoldEnabled(true)`, so `release()` returns at the hold guard before it can queue anything, and the pedal-up drain loop iterates an empty set.

So pedal-up runs `releaseAll` and cuts every note, including keys still physically held. A real pedal never damps a key that is still down.

The fix is to drop `setHoldEnabled(pressed)` from `setSustainPedal` and extract the note-off sequence already duplicated between `release()` and the drain loop. Hold stays the bigger hammer and still wins the guard when explicitly enabled. Nothing outside `SamplePlayer` reads `holdEnabled` or `hold:enabled`.

Loop-on-pedal is untouched and remains a separate question.

**Needs an ear test.** Pedal-up currently forces a 0.1s release via `releaseAll(0.1)`. Per-note `noteOff` leaves `releaseTime` undefined, so each voice uses its own envelope release. Different, probably longer.
