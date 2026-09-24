# @kidlib/web-audio

## 0.5.2

### Patch Changes

- 01053c9: Pitch envelope values are now bipolar semitone offsets: `-1..1` spans one octave down to one octave up, and `0` is unison (previously the value multiplied the note's playback rate, so `1` was unison and the envelope could only bend down). The default pitch shape is flat at `0`. Non-step curves play exponentially in rate, so bends are linear in pitch.

  SamplePlayer setLpfCutoff defaults to "pre".

## 0.5.1

### Patch Changes

- f5feb08: Breaking envelope API renames since 0.5.0. There is no compatibility layer, and configs saved in the old shape have to be migrated by the caller.

  | 0.5.0                                                         | Now                                                                |
  | ------------------------------------------------------------- | ------------------------------------------------------------------ |
  | `getEnvelopeConfig(id)`                                       | `getEnvelope(id)`                                                  |
  | `applyEnvelopeConfig(id, config)`                             | `updateEnvelope(id, patch)`: shallow merge into the current config |
  | `setEnvelopeSync(id, sync)`                                   | `updateEnvelope(id, { playbackRateSync: sync })`                   |
  | `resetEnvelopes()`                                            | `resetEnvelope()` (with no id it resets all)                       |
  | `availableEnvelopeIds`                                        | `envelopeIds`                                                      |
  | `EnvelopeConfig.envelope`                                     | `EnvelopeConfig.shape`                                             |
  | `EnvelopeShape.sustain` / `.release`                          | `EnvelopeShape.sustainPoint` / `.releasePoint`                     |
  | `SampleEnvelopeId` `'amp-env'`, `'pitch-env'`, `'filter-env'` | `'amp'`, `'pitch'`, `'filter'`                                     |
  | `envelope:changed` `{ envelopeId, settings }`                 | `envelope:changed` `{ id, config }`                                |
  - `EnvelopeConfig` now carries `playbackRateSync`, so `getEnvelope` returns it, `envelope:changed` includes it and `resetEnvelope` turns it off.
  - `updateEnvelope` does a shallow merge, so a `shape` in the patch replaces the whole shape.

## 0.5.0

### Minor Changes

- c0e3511: Breaking envelope API changes since 0.4.2:

  - Replace `EnvelopeState` with `EnvelopeConfig`: `{ enabled, timeScale, envelope }`. Replace `PointEnvelopeShape` with `EnvelopeShape`: `{ points, mode, sustain, release }`. Rename `sustainIndex`/`releaseIndex` to `sustain`/`release`; remove `kind` and `valueRange`. Both indices are required. Set `mode` to `{ type: 'once' | 'sustain' | 'loop' }` instead of using `loop` and a nullable sustain index. Loops repeat the whole shape forward; reverse and ping-pong modes are no longer supported.
  - On `SamplePlayer`, rename `getEnvelopeState`/`applyEnvelopeState` to `getEnvelopeConfig`/`applyEnvelopeConfig`, and `availableEnvelopeTypes` to `availableEnvelopeIds`. Rename the `EnvelopeType` type to `SampleEnvelopeId`; the ID strings are unchanged.
  - Replace `SamplePlayer.getEnvelope`, `enableEnvelope`, `disableEnvelope`, `setEnvelopeLoop`, `setEnvelopeTimeScale`, `setEnvelopeSustainPoint`, `setEnvelopeReleasePoint`, `addEnvelopePoint`, `updateEnvelopePoint` and `deleteEnvelopePoint` with edits to a config followed by `applyEnvelopeConfig(id, config)`.
  - Set playback-rate synchronization separately with `setEnvelopeSync(id, enabled)`; `playbackRateSync` is no longer stored in the config. `envelope:changed` now carries `{ envelopeId, settings }` instead of `{ envelopeType, state }`; changing sync no longer emits this event.
  - `defaultEnvelopeState`, `CustomEnvelope` and `EnvelopeData` are no longer root exports. Use `getEnvelopeConfig` and `resetEnvelope`/`resetEnvelopes` for sampler defaults. For standalone playback, use `new Envelope(clock, param, shape)` with `trigger(time?, { base, amount, timeScale, shape?, fromPoint? })`, `release(time?)` and `stop(time?)`.
  - Added `envelopePresets.amplitude(seconds?)`, `envelopePresets.filter(seconds?)` and `assertValidEnvelopeShape`. Presets return shapes; amplitude now defaults to sustain mode. `EnvelopePoint.curve` also accepts `'step'`.

  The envelopes API is still being finalized and may change in subsequent pre-1.0 releases.

### Patch Changes

- e4d1f93: - `SamplePlayer.setLpfCutoff` now targets both pre- and post-FX filters by default; `setHpfCutoff` targets post-FX. Pass `'pre'` explicitly to retain the previous defaults.
  - Filter keytracking is off by default, and voice and bus filters use the same Q and cutoff smoothing.
  - Cutoff `glideTime` is now the ramp duration: positive values become a `glideTime / 3` time constant (previously a glide took ~3x as long as requested); omitted, non-positive, and non-finite values use default smoothing. Cutoff setters honor `cancelPrevious: false` to preserve scheduled automation.
  - The default voice chain places the LPF after feedback (`am -> hpf -> feedback -> lpf`).
  - `HarmonicFeedback.setDelay` and `setDelayMultiplier` treat non-positive and non-finite glide times as immediate changes.
  - Added the root `DEFAULT` export for shared library defaults.

## 0.4.2

### Patch Changes

- 5ef0d7a: No longer emits voice:started/voice:releasing/voice:stopped events

## 0.4.1

### Patch Changes

- 51d2e1b: Rework the voice lifecycle to fix stuck notes.

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
  - A repeated midinote can own several sounding voices, and at max polyphony the pool steals the oldest voice instead of dropping the new note.
  - `stop()` is a hard edge for now. The host-side 5 ms de-click ramp was removed because it only ever applied to host-initiated stops, while three of the four paths that end rendering are decided in the processor. Moving the fade there is tracked in #65.

  The `voice:started`, `voice:releasing` and `voice:stopped` upstream events are unchanged for now, but might be removed soon if a valuable use case is not found.

- f08ca69: Retune the bus compressor and limiter defaults: the old release times were short enough to modulate the waveform rather than its level, which pumped and distorted on low content. Removes polyphony gain compensation, so chords now sit louder relative to single notes.

## 0.4.0

### Minor Changes

- a19e0b9: Add the `@kidlib/web-audio/debug` entry point, exporting `monitorLevels`. `SamplePlayer`, `InstrumentBus`, `SampleVoicePool` and `SampleVoice` gain a `getGainStages()` method reporting per-stage peak, RMS and clip counts while audio runs.

  Removes `LevelMonitor` and the `startLevelMonitoring`, `stopLevelMonitoring` and `logLevels` methods. They rewired the graph to insert analysers and broke the signal path on any graph not wired straight to `ctx.destination`. Use `monitorLevels` instead.

  `clippingThreshold` now has a non-zero minimum; zero produced NaN.

### Patch Changes

- 1aeb8bf: Fix gain staging in the voice and distortion paths. A dry bypass around `HarmonicFeedback` doubled the voice output (+6 dB) even at zero feedback. The distortion worklet no longer hard-clips above 0 dBFS, and its clipped path normalizes to a fixed ceiling instead of scaling with the threshold, so the `distortion` macro no longer loses ~7 dB over the top of its travel.

  Distortion at high macro settings is louder than before.

## 0.3.10

### Patch Changes

- de48889: Expose AM modulation octave offset on SamplePlayer. Default is +1 octave, changing the AM modulator pitch for existing users.

## 0.3.9

### Patch Changes

- 34dea20: - Improve sampler timing and release behavior.
  - Notes scheduled with a future timestamp now honor the future start time correctly.
  - Looping voices stop reliably after retriggers or all-notes-off.
  - Looping-envelope releases produce audible clicks less often.

## 0.3.8

### Patch Changes

- c955fee: Loop and envelope fixes:

  - Short loops played above rate 1 now hold their pitch (forward and reverse).
  - Finer `loopStart`/`loopEnd` step resolution (`0.001` -> `0.0001`), needed for short loops in samples longer than ~1.9s.
  - Pan drift depth no longer varies with loop length, and is off for audio-rate loops.
  - Fix click on amp envelopes release start when sustain is enabled.

  Note: `loopEnd` now precedes `loopDuration` in `samplerParams`. Both write the loop end, so hosts applying params in declaration order will see `loopDuration` win. Defaults unchanged.

## 0.3.7

### Patch Changes

- 1a8faea: Reduce clicks in duration-preserved sample playback.

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
