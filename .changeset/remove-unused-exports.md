---
'@kidlib/web-audio': minor
---

Breaking: exports with no known consumer are removed. They can come back once something uses them.

- The `@kidlib/web-audio/components` entry point (`KnobElement`, `registerKnobElement`, `defineElement`).
- `@kidlib/web-audio/io` now exports only `inputController`, `getMidiSupportInfo` and the types `NoteTarget`, `NoteEvent`, `ControlChangeEvent`. Everything else there is removed; `keymaps`, `DEFAULT_KEYMAP_KEY`, `getAudioInputDevices` and `getAudioOutputDevices` remain on the root entry.
- `Envelope`, `envelopePresets`, `assertValidEnvelopeShape` and the types `EnvelopeClock`, `EnvelopeTriggerOptions`, `AutomatableParam`. Configure envelopes through `SamplePlayer`'s `getEnvelope` and `updateEnvelope`.
- `Oscilloscope`, `DEFAULT`, `defaultKeymap`, `generateKeymap` and the types `LibNode`, `LibAudioNode`, `SamplerParamPatch`. `defaultKeymap` is still available as `keymaps.piano`.
