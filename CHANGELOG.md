# @kidlib/web-audio

## 0.2.0

### Minor Changes

- a6230a4: Breaking:

  - `SamplePlayer.enablePitch()` / `disablePitch()` → `setPitchEnabled(enabled: boolean)`.
  - Removed the `samplerToggles` export and the `SamplerToggleKey` / `SamplerToggleDescriptor`
    types. Call the player setters directly; labels and glyphs belong in the app.

## 0.1.6

### Patch Changes

- 1a06820: Add slider ARIA semantics, keyboard controls, and toggleable Shift-drag fine control to `KnobElement`.

## 0.1.5

### Patch Changes

- 92c5602: Improve geometric interpolation stability and preserve exact endpoint values.

## 0.1.4

### Patch Changes

- f63809c: Update WebMidi.js to 3.1.16 and rely on its bundled TypeScript declarations.
- 7bd3742: When compression is enabled, an explicit `threshold`, `ratio`, or `makeupGain` passed to `preProcessAudioBuffer` is now applied instead of being discarded when the crest factor analysis decides the audio doesn't need compression. The analysis only runs when none of the three are given.
- 960f10e: Rename `SamplerParamPatch` to `SamplerParams`; the old name stays as a deprecated alias for one minor. Replace the `TODO` types on `SampleLoader.loadSample` and `MacroParam.disconnect` with real signatures.
