---
"@kidlib/web-audio": patch
---

Rework the voice lifecycle to fix stuck notes.

Public API changes, all reachable through `SamplePlayer.voicePool`:

- `SampleVoice.currMidiNote` is now `SampleVoice.midiNote`.
- `SampleVoice.isActive` removed — read `state` instead.
- `SampleVoice.activeNoteId` removed.
- `SampleVoice.setMasterGain` removed, along with the polyphony gain compensation that called it.
- `SampleVoicePool.availableVoices` and `assignedVoicesMidiMap` removed.
- `SampleVoicePool.allocate()` no longer takes arguments.
- `VoiceState` is now `AVAILABLE | PLAYING | RELEASING`, down from `NOT_READY | LOADED | PLAYING | RELEASING | STOPPING | STOPPED`. Loaded-ness is tracked separately, since a voice can be reloaded while sounding.

Behaviour:

- Voice completion is matched by `triggerId`, so a retrigger during the worklet round trip can no longer be ended by the previous note's message. This was the stuck-note cause.
- State transitions are synchronous and no longer wait on processor acknowledgements. The pool derives its counts from the voices rather than keeping parallel sets that could disagree.
- A repeated note can own several sounding voices, and at max polyphony the pool steals the oldest voice instead of dropping the new note.
- `stop()` is a hard edge for now. The host-side 5 ms de-click ramp was removed because it only ever applied to host-initiated stops, while three of the four paths that end rendering are decided in the processor. Moving the fade there is tracked in #65.

The `voice:started`, `voice:releasing` and `voice:stopped` upstream events are unchanged.
