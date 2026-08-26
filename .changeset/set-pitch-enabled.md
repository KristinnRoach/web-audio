---
"@kidlib/web-audio": minor
---

Replace `SamplePlayer.enablePitch()`/`disablePitch()` with `setPitchEnabled(enabled)`.

Breaking: removes the `samplerToggles` export and the `SamplerToggleKey` /
`SamplerToggleDescriptor` types. It held display strings and glyphs that no code in
this package consumed; apps call the setters directly instead.
