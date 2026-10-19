---
'@kidlib/web-audio': minor
---

API removals:

- `SamplePlayer`: `mainOut` → `output`, `panic` → `releaseAll`, `sustainPedalOn`/`Off` → `setSustainPedal`. `outBus`/`outputBus` → effect setters (`setDistortionMacro`, `setDrive`, `setClippingMacro`, `setDelayTime`, `setDelayFeedback`). `voicePool` and `setLoopPoint` are now private; use `setLoopStart`/`setLoopEnd`/`setLoopDuration`.
- `SamplePlayer.freezeActiveVoices`, `randomizeVelocity`, `debugcounter` and `isNormalized` are removed, as is `Recorder.init()`.
- `inputController`: `registerNoteTarget` → `onNoteOn`/`onNoteOff`, and `midiSupported`/`supportInfo` → `getMidiSupportInfo()`.
- `sendUpstreamMessage` is now private everywhere.
- `setLoopEnabled` reapplies the value even when it is unchanged, which restores loop state after loading.
