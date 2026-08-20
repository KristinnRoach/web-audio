# Sample layering — handoff

PoC: `SamplePlayer` plays up to 4 buffers simultaneously through one `InstrumentBus`.

## Discoveries

- All processors for a `BaseAudioContext` share one `AudioWorkletGlobalScope`, and our processors ship as one ES module via a single `addModule`. Module-level state is therefore shared across every processor instance. Verified in Chromium 1234 / Firefox 1538 / WebKit 2336: shared counter, instances reading a buffer they never received, `registry.get(k) === lastStored` identity holding. A second `AudioContext` gets its own scope. So per-voice buffer duplication is a ~30-line module-registry fix, no `SharedArrayBuffer`, no COOP/COEP. **Not done here — independent of layering.**
- Each `SampleVoice` runs **two** worklets: the player, plus a feedback delay inside `HarmonicFeedback` (`worklet-factory.ts:10`). Full voice graph is 8 nodes. At 16-voice polyphony that's 128 nodes / 32 worklets per instrument.
- `this.buffer` in the processor had only 3 write sites and 11 read sites. Replacing the writes with a `layers[]` array and adding `get buffer() { return this.layers[0] }` makes every read site mean "authority layer" for free.
- `parameterDescriptors` is a static getter, so per-layer `AudioParam`s can't be created per instance. Per-layer gain is either a fixed `layerGain0..N` descriptor set or postMessage scalars.
- `#gainReductionScalar` already owns `voice.setMasterGain()` and rewrites it on every voice-state change (`SampleVoicePool.ts:315`). Anything parked there gets stomped.

## Decisions

- **Shared playback path, not independent voice chains.** Layers sum inside the existing processor at one playhead. Node count stays flat at any L. The rejected alternative — N `SamplePlayer`s sharing an injected bus — has a ~30-line diff but costs L × 32 worklets, and is a different feature: a **multi-instrument rack**, worth building under that name if wanted.
- **Layer 0 is the length authority.** Shorter layers fall silent past their end via the existing `|| 0` index guard; longer ones truncate. Free. Rejected: normalize-to-0–1 (requires per-layer playheads, which is the expensive rewrite), shortest-clamp, resample-at-load.
- **`loadLayers(buffers[])` is atomic.** Replaces the whole set. `loadSample(b)` ≡ `loadLayers([b])`, so it clears layers 1-3. `loadLayer(i, b)` extends later as sugar for `loadLayers(layers.with(i, b))`.
- **`MAX_LAYERS = 4`** — the number that keeps fixed `layerGain0..3` descriptors viable later.
- **Preprocessing runs per layer.** Independent `trimSilence` aligns each layer to its own first non-silence, so attacks line up.
- **`layerGain = 1/L`**, its own factor in the processor (not `masterGain`, see above). Correct for coherent layers, 3dB conservative otherwise.
- **No automated test.** Testing strategy is undefined and the API is still moving; verification is manual e2e via a linked consuming app. The one bug a test would have caught (layer 1's load resetting layer 0) is instead correct by construction: one message replaces all slots and resets state once.

## Deferred

- **Per-layer detune.** A shared playhead cannot express it, so octave layers aren't available. Not the point of the feature, but a likely follow-up. Cheapest route: bake it at load by offline-resampling the layer by `2^(semitones/12)` via `getOfflineAudioContext` (~20 lines) — a load-time property, not a live param. The alternative, a position per layer, is the rewrite. The mixing loop is already shaped for it: `pos` is hoisted outside an explicit per-layer loop, so it becomes `pos[l]`.
- **Zero crossings are layer 0's only.** Loop-boundary snapping is therefore wrong for layers 1+ — expect clicks there; the existing crossfade and `loopClickCompensation` are all that cover it. Intersecting crossing sets is usually empty.
- **`#analyzeLoopAmplitude` measures layer 0**, but makeup gain should reflect the RMS of the sum, and RMS-of-sum ≠ sum-of-RMS for correlated layers.
- **Params and `cropSample` act on layer 0** (`sampleDuration`, `audiobuffer`, start/end/loop macros). Deliberate — revisit once the per-layer UI question is real.
- **Per-layer user gain / modulation** — needs the fixed `layerGain0..3` descriptors.
- **Buffer deduplication** via the module-scope registry above.

## State

Builds clean, 122 unit tests pass. Nothing verified audibly.

Files: `sample-player-processor.js` (`layers[]`, `buffer` getter, `voice:setLayers`, mixing loop), `SampleVoice.loadLayers`, `SampleVoicePool.setLayers`, `SamplePlayer.loadLayers` + `get layers()`.

First things to listen for: clicks at loop boundaries on layers 1+, and whether `1/L` is too quiet in practice.
