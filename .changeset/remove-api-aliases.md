---
'@kidlib/web-audio': minor
---

Remove `SamplePlayer.mainOut`, `panic`, `sustainPedalOn`, and `sustainPedalOff`; use `output`, `releaseAll`, and `setSustainPedal` instead. Remove `SamplePlayer.outputBus`; use the player's effects setters. Make `setLoopPoint` private; use `setLoopStart`, `setLoopEnd`, or `setLoopDuration`. Remove `inputController.registerNoteTarget`; use `onNoteOn` and `onNoteOff` to retain full event data.

Make `sendUpstreamMessage` private on the player, voices, voice pool, and audio-node wrapper. Remove `inputController.midiSupported` and `supportInfo`; use `getMidiSupportInfo()` instead.

Make `SamplePlayer.voicePool` private. `setLoopEnabled` now reapplies the value to voices even when unchanged, so callers can restore loop state after loading without accessing the pool. Loop locks and change-event semantics are preserved.
