# @kidlib/web-audio

## 0.3.6

### Patch Changes

- b8c1479: `trimAudioBuffer` fade options

  `fadeMs` is now a required `{ in, out }`: milliseconds, `"default"` for the
  shortest fade that hides a cut at the buffer's sample rate, or `0` to skip that
  side. Replaces `PreProcessOptions.fadeInOutMs`. Neither symbol is exported from
  the package root.

## 0.3.5

### Patch Changes

- c2d8115: Rename pitch-detection `confidence` to `periodicity`

  - `PreProcessOptions.tune.minConfidence` -> `minPeriodicity` (new default 0.35)
  - `PreProcessResults.detectedPitch.confidence` -> `periodicity`

  Same value, new name: it measures whether the input is pitched at all, not
  whether the detected frequency is correct. Use it to reject noise, not to
  trust the note.

- 6184829: Remove redundant pitch-detection API

  - `detectSinglePitchAC` is no longer exported from the package root
  - `SamplePlayer.detectPitch` and `SamplePlayer.detectedPitchToTransposition` removed
  - the `sample:pitch-detected` message is gone

  Pitch detection stays available through the preprocess options on `loadSample`
  and `loadLayers`.

## 0.3.4

### Patch Changes

- 9d437bd: Breaking — constructor signatures now take an options object

  - createSamplePlayer(buffer, polyphony?, context?) → createSamplePlayer(buffer, options?)
  - new SamplePlayer(context, polyphony?, audioBuffer?) → new SamplePlayer(options?)
  - Both take { context?, polyphony?, audioBuffer?, voiceSignalChain? }. context now defaults to the global context instead of being required.

  New: configurable per-voice signal chain

  - voiceSignalChain accepts an ordered, duplicate-free subset of "feedback" | "am" | "hpf" | "lpf". [] bypasses all optional voice effects; omitted effects ignore their related controls. Duplicates throw TypeError.
  - New public types: SamplePlayerOptions, SampleVoiceChainNode.

  Behaviour changes

  - Default voice chain order is now lpf → hpf → am → feedback (was feedback → am → hpf → lpf). Existing patches using filters + AM/feedback will sound different.
  - Sample preprocessing: compression is off by default. Pitch detection and auto-HPF now run on a separate internally-compressed buffer, so detection accuracy is unchanged while the output path is no longer compressed.
  - Stopping a voice now cancels its in-flight envelope runs; stale envelope callbacks after stop no longer fire or mutate loop state.
  - Envelope param cancellation unified on cancelAndPinParamValue — removes the click when re-triggering during a setValueCurveAtTime (Chrome) and the Firefox cancelAndHoldAtTime gap.

  New API

  - SamplePlayer.availableEnvelopeTypes: EnvelopeType[] — envelope types present on the current voices (empty until the pool initializes; reflects which effects your voiceSignalChain includes). If 'lpf' is omitted from voice chain, filter-env is not available (for now)

## 0.3.3

### Patch Changes

- c425d1a: Fix filter keytracking, which moved cutoffs by the wrong amount. Filter cutoffs now match their configured value at unity playback rate and track pitch from there, so existing patches sound roughly an octave brighter on the HPF. LPF keytracking is on by default and no longer overwritten by the filter envelope.

## 0.3.2

### Patch Changes

- 76ee80a: - `defaultEnvelopeState(type: EnvelopeType, durationSeconds?: number): EnvelopeState` - Added a public helper for duration-scaled, serializable envelope defaults.
  - `SamplePlayer.resetEnvelope(type: EnvelopeType): void` - Added a method to reset one envelope using the current sample duration.
  - `SamplePlayer.resetEnvelopes(): void` - Added a method to reset all sample envelopes using the current sample duration.
  - `CustomEnvelope.getDefaults(envType: EnvelopeType, durationSeconds?: number)` - Removed; use `defaultEnvelopeState` instead.
  - `EnvelopeType` - Removed the unsupported `"loop-env"` and `"default-env"` literals.
  - `SampleEnvelopeType` - Removed; use `EnvelopeType` instead.

## 0.3.1

### Patch Changes

- 2d96f92: Improve envelope loop duration consistency so defaults to selected sample duration.

## 0.3.0

### Minor Changes

- ce36062: Add `SamplePlayer.getEnvelopeState()` / `applyEnvelopeState()` for serializable
  envelope snapshots, plus `EnvelopeState`, `PointEnvelopeShape` and
  `SampleEnvelopeType` exports. Every envelope mutator now emits a single
  `envelope:changed` message carrying the full state.

  `getEnvelope()` is deprecated. Prefer the state APIs.

  Envelope release behavior changed:

  - Looping envelopes no longer auto-release. The note is held until an explicit
    release, or until the loop is switched off, which fires the missed release.
  - Changing the sustain point mid-note resumes from the envelope's current
    position instead of restarting the curve, and now applies while looping too.

## 0.2.1

### Patch Changes

- 75982d0: Adjusting loop points for audiorate loop durations does not begin gliding towards target quantized pitch unless the target is closer to a different value then the current quantized value.

  `tuningOffset` on `setScale` now shifts the allowed periods upward in pitch for
  positive values. It previously shifted them down, opposite to every other semitone
  value in the package. It is also preserved across `setRootNote`, along with the octave range,
  `normalize`, and `snapToZeroCrossings`, which were all silently reset to defaults.

  Breaking for callers passing a nonzero `tuningOffset`: negate it to keep the old
  result.

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
