# Voice addressing — design record

One fact, several representations. Every desync bug in this area is two of them disagreeing.

## Root cause

A voice's state is owned by `SampleVoice.#state`. Host-driven transitions happen synchronously at the call sites; the processor reports the one transition only rendering can discover, when playback reaches its natural end.

`SampleVoicePool` kept four copies of that fact — `#available`, `#playing`, `#releasing`, and `#playingMidiVoiceMap` — and rebuilt them from worklet messages. Those messages lagged by a round trip, so the pool's view was a stale copy of state the voice already knew.

The map had a second problem. It was keyed by note but invalidated per voice, and `Map<note, voice>` cannot hold the several voices a note can own. `allocate()` reused a RELEASING voice without dropping its old key, so one voice could end up under two notes.

## Done: the voice layer

`VoiceState` is three states — AVAILABLE, PLAYING, RELEASING. Readiness is tracked separately by `#hasLoadedAudio`, since a voice can be reloaded while sounding.

`SampleVoice.#transitionTo` owns the invariants for all three states. Start, release, and explicit stop no longer wait for processor acknowledgements. The processor reports `voice:ended` only when it reaches the playback boundary, and `SampleVoice` turns that into the existing upstream `voice:stopped` event.

A `voice:ended` message is correlated with the trigger that caused it by `triggerId`, a counter `SampleVoice` bumps on each transition to PLAYING and echoes through the processor. A retrigger during the round trip therefore cannot be ended by the previous note's message.

## Done: the pool

`SampleVoicePool` now keeps only `#allVoices` and derives lifecycle facts by scan — polyphony is 8–64:

- counts: filter `#allVoices` on `voice.state`
- `noteOff(note)`: release every voice where `voice.midiNote === note` and state is PLAYING
- `allocate()`: first AVAILABLE, else oldest RELEASING, else oldest PLAYING

At max polyphony the pool steals rather than dropping the new note. Repeated notes can own multiple sounding voices without a note-keyed bookkeeping structure.

The pool's lifecycle message handlers now serve only `#updateVoiceGains` and upstream notification.

`SampleVoicePool.test.ts` now exercises allocation priority, deterministic stealing, repeated-note ownership, note-off fan-out, and state-derived targeting without reading private bookkeeping.

## Follow-up

Separating sustain-pedal releases from hold mode is tracked in [#67](https://github.com/KristinnRoach/web-audio/issues/67), with commit-pinned context for the post-filter envelope branch.
