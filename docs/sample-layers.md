# Sample layering — design record

`SamplePlayer` plays up to 4 buffers simultaneously through one `InstrumentBus`. Landed in PR #5.

Implementation: `sample-player-processor.js` (`layers[]`, `buffer` getter, `voice:setLayers`, mixing loop), `SampleVoice.loadLayers`, `SampleVoicePool.setLayers`, `SamplePlayer.loadLayers` + `get layers()`.

## Discoveries

- All processors for a `BaseAudioContext` share one `AudioWorkletGlobalScope`, and our processors ship as one ES module via a single `addModule`. Module-level state is therefore shared across every processor instance. Verified in Chromium 1234 / Firefox 1538 / WebKit 2336: shared counter, instances reading a buffer they never received, `registry.get(k) === lastStored` identity holding. A second `AudioContext` gets its own scope. So per-voice buffer duplication is a ~30-line module-registry fix, no `SharedArrayBuffer`, no COOP/COEP. **Not done here — independent of layering.**
- Each `SampleVoice` runs **two** worklets: the player, plus a feedback delay inside `HarmonicFeedback` (`worklet-factory.ts:10`). Full voice graph is 8 nodes. At 16-voice polyphony that's 128 nodes / 32 worklets per instrument.
- `this.buffer` in the processor had only 3 write sites and 11 read sites. Replacing the writes with a `layers[]` array and adding `get buffer() { return this.layers[0] }` makes every read site mean "authority layer" for free.
- `parameterDescriptors` is a static getter, so per-layer `AudioParam`s can't be created per instance. Per-layer gain is either a fixed `layerGain0..N` descriptor set or postMessage scalars.
- `#gainReductionScalar` already owns `voice.setMasterGain()` and rewrites it on every voice-state change (`SampleVoicePool.ts:315`). Anything parked there gets stomped.

## Decisions

- **Shared playback path, not independent voice chains.** Layers sum inside the existing processor at one playhead. Node count stays flat at any L. The rejected alternative — N `SamplePlayer`s sharing an injected bus — has a ~30-line diff but costs L × 32 worklets, and is a different feature: a **multi-instrument rack**, worth building under that name if wanted.
- **Layer 0 is the length authority.** Shorter layers fall silent past their end via the existing `|| 0` index guard; longer ones truncate. Free. Rejected: normalize-to-0–1 (requires per-layer playheads, which is the expensive rewrite), shortest-clamp, resample-at-load. **Under review** — [#6](https://github.com/KristinnRoach/web-audio/issues/6) may move the authority to the longest layer, which would touch duration, playback range, loop points, start/end and zero crossings together.
- **Losing layer 0 fails the load.** Extra layers at the wrong sample rate are dropped individually and the rest still play, but `SampleVoice.loadLayers` refuses the whole load rather than silently promoting layer 1 to authority, which would take duration and loop range from a buffer nobody designated.
- **`loadLayers(buffers[])` is atomic.** Replaces the whole set. `loadSample(b)` ≡ `loadLayers([b])`, so it clears layers 1-3. `loadLayer(i, b)` extends later as sugar for `loadLayers(layers.with(i, b))`.
- **`MAX_LAYERS = 4`** — the number that keeps fixed `layerGain0..3` descriptors viable later.
- **Preprocessing runs per layer.** Independent `trimSilence` aligns each layer to its own first non-silence, so attacks line up.
- **`layerGain = 1/L`**, its own factor in the processor (not `masterGain`, see above). Correct for coherent layers, 3dB conservative otherwise.
- **Automated coverage is deferred to [#7](https://github.com/KristinnRoach/web-audio/issues/7).** The testing architecture needs a maintainable AudioWorklet/browser harness before adding tests likely to be refactored with this first-draft API. Verified by hand in the locally linked consuming app, currently the package's only real consumer.

## Deferred

- **Per-layer detune.** A shared playhead cannot express it, so octave layers aren't available. Not the point of the feature, but a likely follow-up. Cheapest route: bake it at load by offline-resampling the layer by `2^(semitones/12)` via `getOfflineAudioContext` (~20 lines) — a load-time property, not a live param. The alternative, a position per layer, is the rewrite. The mixing loop is already shaped for it: `pos` is hoisted outside an explicit per-layer loop, so it becomes `pos[l]`.
- **Layered loop smoothing** — [#6](https://github.com/KristinnRoach/web-audio/issues/6). Zero crossings are layer 0's only, and loop compensation measures layer 0/channel 0 rather than the mixed signal. Intersecting crossing sets is usually empty.
- **`#analyzeLoopAmplitude` measures layer 0**, but makeup gain should reflect the RMS of the sum, and RMS-of-sum ≠ sum-of-RMS for correlated layers.
- **Params and `cropSample` act on layer 0** (`sampleDuration`, `audiobuffer`, start/end/loop macros). Deliberate — revisit once the per-layer UI question is real.
- **Per-layer user gain / modulation** — needs the fixed `layerGain0..3` descriptors.
- **Buffer deduplication** via the module-scope registry above.
