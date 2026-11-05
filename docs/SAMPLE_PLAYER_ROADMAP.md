# Sample player roadmap

Goal: a small, stable sampler core that morphing, granular and anti-aliasing can build on, and that can later serve as a starting point for hardware, native apps and plugins (VST, CLAP). The web-audio library must keep working throughout.

Steps 1 and 2 completed on 2026-11-04; see [the render reference, timing baseline and API migration](SAMPLE_PLAYER_BASELINE.md). The recovery tag is `sample-player-before-cleanup`.

## Core model

Three ideas should make most of the current branching go away. Step 4 tests whether they hold.

1. **Loop window:** `start`, `length` and `direction`, resolved once from the requested points.
2. **Two loop regimes:** the code already splits on `pitchPreservationThreshold`, but the checks are scattered.
   - **Oscillator** (length is pitch): quantize, length and position glide, phase carry. Morphing goes here.
   - **Sample** (length is time): keytrack, zero-crossing snap, tempo sync later.
3. **Read heads:** every sound comes from reading the source at a position with a gain. The playhead, crossfade heads and the stretcher's outgoing position are three versions of this today. Morph frames and grains would be more of the same.

Features that need the source buffer or playhead live in the voice engine; audio-in, audio-out effects can be separate processors.

## Steps

Each step is one or more small PRs with no audible change, unless noted.

1. **Safety net — complete:** Added render tests for moving quantized loops, ping-pong and stretch, plus a 16-voice timing baseline.
2. **Cleanup — complete:** Removed multiple-buffer playback and tempo sync; preserved both in `sample-player-before-cleanup`.

### 3. Needs research

Answer in this order, since each answer can change or cancel the ones below it. Nothing here is decided yet.

| #   | Question                                                                                                                                                                                 | Depends on | Blocks           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| 1   | How should web and native share DSP? One native core compiled to WASM, separate JS and native engines checked against shared renders.                                                    | None       | Everything below |
| 2   | Is keeping the JS engine beneficial after a port? Weigh fast prototyping, fallback and reference output against maintaining two engines.                                                 | 1          | 6, steps 6 and 7 |
| 3   | If there is a native core, Rust or C++? Compare WASM, plugin and hardware tooling.                                                                                                       | 1          | 5, step 7        |
| 4   | Where does sample memory live, and is `SharedArrayBuffer` needed? Compare per-voice copies, one shared store and shared memory, including the cross-origin isolation cost for consumers. | 1          | 5, step 4.4      |
| 5   | What engine boundary does this need? Run a small throwaway spike outside the refactor to check bundling, memory and CPU against JS.                                                      | 3, 4       | Step 4.4         |
| 6   | Port before or after the features?                                                                                                                                                       | 2, 5       | Steps 6 and 7    |

### 4. Split, then simplify

Items 1 to 3 do not wait for the research in step 3; item 4 does.

1. **Shell and engine — complete:** the processor keeps registration, messages, descriptors and `process()`; `engine/voice-engine.js` gets `sampleRate`, time and random values passed in, with no AudioWorklet globals ([#145](https://github.com/KristinnRoach/web-audio/pull/145)). It still reads the `parameters` arrays directly, since flattening them means choosing the engine boundary.
2. **Pure stages — complete:** quantize, glide, keytrack and drift are small functions in `engine/loop-length.js` ([#146](https://github.com/KristinnRoach/web-audio/pull/146)).
3. **Core model:** read heads now mix in one list, and per-block render allocations are gone ([#147](https://github.com/KristinnRoach/web-audio/pull/147)). The loop window and regimes are on hold until the core model is discussed.
4. **Playhead as an offset from the window start (oscillator regime):** try this here. Window moves would no longer need the carry logic, and morphing needs a shared phase anyway. Drop it if it doesn't simplify things.

### 5. Param contract

Replace the paired `loopStart`/`loopEnd` AudioParams with position and length, which removes the Float32 tolerance workaround. This is the largest test churn (about 220 references), so it comes after the model has settled. The public `SamplePlayer` API can stay as it is.

### 6. Features

Prototype each on a branch against the stable core. Order is a suggestion.

- **A. Morphing:** in the oscillator regime, crossfade between window positions at the same phase. Start from the ideas in `proto/loop-move-latch`.
- **C. Anti-aliasing:** add a seam for how heads read the source, then choose between band-limited copies per octave and a filtered kernel. Start from `prototype/rate-8-loop-prefilter`. Done after A because the two interact: moving between band-limited tables at audio rate [can add sidebands](https://www.kvraudio.com/forum/viewtopic.php?p=8105138) (forum source, verify when we get there).
- **B. Granular:** more heads with window envelopes, for stretch modes and simple creative effects, detune and widening. Could replace `SpliceStretcher` if it sounds better.
- **D. Audio-rate modulation:** move envelopes and selected modulators to the audio thread where audio-rate operation is needed, which may also remove the need for idle range reports used for envelope timing.

### 7. Port

Scope and order come from step 3. The render tests provide the reference output.

### Port-ready rules from step 4 on

- The engine doesn't touch `port`, `currentTime` or `sampleRate` globals.
- No allocation while rendering: preallocate, and use plain numbers and typed arrays.
- No JS-specific tricks in DSP code.

## File structure draft

```text
src/worklets/
  processors/play/
    sample-player-processor.js    # shell: messages, params, process()
    sample-player-paramdescriptors.ts
    engine/                       # no AudioWorklet globals
      voice-engine.js             # orchestration
      loop-window.js              # requested points -> window + regime
      loop-length.js              # quantize, glide, keytrack, drift
      loop-edges.js               # existing
      loop-crossfade.js           # existing
      splice-stretch.js           # existing
    test/
  shared/
    dsp/                          # used by more than one processor, or clearly generic
      interpolate.js
      glide.js
      findNearestZeroCrossing.js  # moved from shared/utils
```

Features add files only when they arrive, such as `engine/morph.js`, `engine/grains.js` and `engine/source-reader.js`. Move something to `shared/` once it is clearly generic, not in anticipation.

## Later decisions

Not needed until we reach them:

- Morph frame spacing and whether it snaps to the quantized period
- Anti-aliasing method and memory budget
- Grain count and envelope
- Hardware board
