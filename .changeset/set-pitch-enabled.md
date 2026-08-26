---
"@kidlib/web-audio": minor
---

Breaking:

- `SamplePlayer.enablePitch()` / `disablePitch()` → `setPitchEnabled(enabled: boolean)`.
- Removed the `samplerToggles` export and the `SamplerToggleKey` / `SamplerToggleDescriptor`
  types. Call the player setters directly; labels and glyphs belong in the app.
