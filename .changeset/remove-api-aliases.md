---
'@kidlib/web-audio': minor
---

Remove `SamplePlayer.mainOut`, `outputBus`, `panic`, `sustainPedalOn`, and `sustainPedalOff`; use `output`, `outBus`, `releaseAll`, and `setSustainPedal` instead. Make `setLoopPoint` private; use `setLoopStart`, `setLoopEnd`, or `setLoopDuration`. Remove `inputController.registerNoteTarget`; use `onNoteOn` and `onNoteOff` to retain full event data.

Make `SamplePlayer.sendUpstreamMessage` private. Remove `inputController.midiSupported` and `supportInfo`; use `getMidiSupportInfo()` instead.
