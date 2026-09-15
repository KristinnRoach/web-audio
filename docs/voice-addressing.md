# Voice addressing — design record

One fact, several representations. Every desync bug in this area is two of them disagreeing.

## Root cause

A voice's state is owned by `SampleVoice.#state`. Host-driven transitions happen synchronously at the call sites; the processor reports the one transition only rendering can discover, when playback reaches its natural end.

`SampleVoicePool` keeps four copies of that fact — `#available`, `#playing`, `#releasing`, and `#playingMidiVoiceMap` — and rebuilds them from worklet messages. Those messages lag by a round trip, so the pool's view is a stale copy of state the voice already knows.

The map has a second problem. It is keyed by note but invalidated per voice, and `Map<note, voice>` cannot hold the several voices a note can own. `allocate()` reuses a RELEASING voice without dropping its old key, so one voice ends up under two notes.

## Done: the voice layer

`VoiceState` is three states — AVAILABLE, PLAYING, RELEASING. Readiness is tracked separately by `#hasLoadedAudio`, since a voice can be reloaded while sounding.

`SampleVoice.#transitionTo` owns the invariants for all three states. Start, release, and explicit stop no longer wait for processor acknowledgements. The processor reports `voice:ended` only when it reaches the playback boundary, and `SampleVoice` turns that into the existing upstream `voice:stopped` event.

## Done: the pool

`SampleVoicePool` now keeps only `#allVoices` and derives lifecycle facts by scan — polyphony is 8–64:

- counts: filter `#allVoices` on `voice.state`
- `noteOff(note)`: release every voice where `voice.midiNote === note` and state is PLAYING
- `allocate()`: first AVAILABLE, else oldest RELEASING, else oldest PLAYING

At max polyphony the pool steals rather than dropping the new note. Repeated notes can own multiple sounding voices without a note-keyed bookkeeping structure.

The pool's message handlers then serve only `#updateVoiceGains` and upstream notification.

`SampleVoicePool.test.ts` now exercises allocation priority, deterministic stealing, repeated-note ownership, note-off fan-out, and state-derived targeting without reading private bookkeeping.

## Reconcile before the follow-up

`SampleVoicePool.ts` is identical on `main` and `post-filter-cutoff-env`, so the pool work branches off either.

The pedal follow-up does not. `InstrumentBus` on `main` has `noteOn` only; `noteOff`, `releaseAll`, `#heldNotes` and `#lpfEnvScheduler` arrive on `post-filter-cutoff-env`, where `#heldNotes` gates the post-FX filter envelope release. `SamplePlayer.release()` differs between the two. The follow-up should land on top of that branch.

## Follow-up: sustain pedal should not be hold

`#sustainedNotes` is a deferred-release queue that never fills. Pedal down calls `setHoldEnabled(true)`, so `release()` returns at the hold guard before it can queue anything, and the pedal-up drain loop iterates an empty set.

So pedal-up runs `releaseAll` and cuts every note, including keys still physically held. A real pedal never damps a key that is still down.

The fix is to drop `setHoldEnabled(pressed)` from `setSustainPedal` and extract the note-off sequence already duplicated between `release()` and the drain loop. Hold stays the bigger hammer and still wins the guard when explicitly enabled. Nothing outside `SamplePlayer` reads `holdEnabled` or `hold:enabled`.

Loop-on-pedal is untouched and remains a separate question.

**Needs an ear test.** Pedal-up currently forces a 0.1s release via `releaseAll(0.1)`. Per-note `noteOff` leaves `releaseTime` undefined, so each voice uses its own envelope release. Different, probably longer.
