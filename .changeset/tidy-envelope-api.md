---
'@kidlib/web-audio': minor
---

Breaking envelope API changes since 0.4.2:

- Replace `EnvelopeState` with `EnvelopeConfig`: `{ enabled, timeScale, envelope }`. Replace `PointEnvelopeShape` with `EnvelopeShape`: `{ points, mode, sustain, release }`. Rename `sustainIndex`/`releaseIndex` to `sustain`/`release`; remove `kind` and `valueRange`. Both indices are required. Set `mode` to `{ type: 'once' | 'sustain' | 'loop' }` instead of using `loop` and a nullable sustain index. Loops repeat the whole shape forward; reverse and ping-pong modes are no longer supported.
- On `SamplePlayer`, rename `getEnvelopeState`/`applyEnvelopeState` to `getEnvelopeConfig`/`applyEnvelopeConfig`, and `availableEnvelopeTypes` to `availableEnvelopeIds`. Rename the `EnvelopeType` type to `SampleEnvelopeId`; the ID strings are unchanged.
- Replace `SamplePlayer.getEnvelope`, `enableEnvelope`, `disableEnvelope`, `setEnvelopeLoop`, `setEnvelopeTimeScale`, `setEnvelopeSustainPoint`, `setEnvelopeReleasePoint`, `addEnvelopePoint`, `updateEnvelopePoint` and `deleteEnvelopePoint` with edits to a config followed by `applyEnvelopeConfig(id, config)`.
- Set playback-rate synchronization separately with `setEnvelopeSync(id, enabled)`; `playbackRateSync` is no longer stored in the config. `envelope:changed` now carries `{ envelopeId, settings }` instead of `{ envelopeType, state }`; changing sync no longer emits this event.
- `defaultEnvelopeState`, `CustomEnvelope` and `EnvelopeData` are no longer root exports. Use `getEnvelopeConfig` and `resetEnvelope`/`resetEnvelopes` for sampler defaults. For standalone playback, use `new Envelope(clock, param, shape)` with `trigger(time?, { base, amount, timeScale, shape?, fromPoint? })`, `release(time?)` and `stop(time?)`.
- Added `envelopePresets.amplitude(seconds?)`, `envelopePresets.filter(seconds?)` and `assertValidEnvelopeShape`. Presets return shapes; amplitude now defaults to sustain mode. `EnvelopePoint.curve` also accepts `'step'`.

The envelopes API is still being finalized and may change in subsequent pre-1.0 releases.
