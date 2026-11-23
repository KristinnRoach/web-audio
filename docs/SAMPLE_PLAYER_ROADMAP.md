# Sample player roadmap

Goal: a small, stable sampler core that morphing, granular and anti-aliasing can build on, and that can later serve as a starting point for hardware, native apps and plugins (VST, CLAP). The web-audio library must keep working throughout.

Steps 1 and 2 completed on 2026-11-04; see [the render reference, timing baseline and API migration](SAMPLE_PLAYER_BASELINE.md). The recovery tag is `sample-player-before-cleanup`.

## Core model

How the engine is organised after step 4:

1. **Loop window:** a resolved `LoopWindow` (`start`, `length`, requested `direction`).
2. **Two loop regimes,** decided once per window as `isPitchLoop`:
   - **Oscillator** (length is pitch): quantize, length and position glide, playhead carry. A move crossfades the whole head mix from the old window to the new one at the same phase, one fade at a time (moves latch). Morphing goes here.
   - **Sample** (length is time): keytrack, zero-crossing snap, tempo sync later.
3. **Read heads:** the playhead, crossfade heads and the stretcher's outgoing position mix in one list. Morph frames and grains would be more of the same.

Features that need the source buffer or playhead live in the voice engine; audio-in, audio-out effects can be separate processors.

## Steps

Each step is one or more small PRs with no audible change, unless noted.

1. **Safety net — complete:** Added render tests for moving quantized loops, ping-pong and stretch, plus a 16-voice timing baseline.
2. **Cleanup — complete:** Removed multiple-buffer playback and tempo sync; preserved both in `sample-player-before-cleanup`.
3. **Research — moved:** the native-port questions now sit under step 7, since none of them block the features.

### 4. Split, then simplify — complete

1. **Shell and engine — complete:** the processor keeps registration, messages, descriptors and `process()`; `engine/voice-engine.js` gets `sampleRate`, time and random values passed in, with no AudioWorklet globals ([#145](https://github.com/KristinnRoach/web-audio/pull/145)). It still reads the `parameters` arrays directly, since flattening them means choosing the engine boundary.
2. **Pure stages — complete:** quantize, glide, keytrack and drift are small functions in `engine/loop-length.js` ([#146](https://github.com/KristinnRoach/web-audio/pull/146)).
3. **Core model — complete:** read heads mix in one list, and per-block render allocations are gone ([#147](https://github.com/KristinnRoach/web-audio/pull/147)). The loop type is decided once, before keytrack, snap and drift ([#149](https://github.com/KristinnRoach/web-audio/pull/149)).
4. **Loop window — complete:** resolved loops are a `LoopWindow` (`start`, `length`, requested `direction`; `end` derived), two preallocated per voice. `direction` replaces the `loopMode` string; the travel direction still turns only at an edge.
   - The playhead stays in source coordinates and the carry stays, now reading the window. Storing it as an offset from the window start was tried and dropped: the hard part is deciding when the playhead follows the window (pitch loops) and when it stays put (time loops, approach, disabled), and an offset only moves that decision into rebasing between coordinate systems. The #151 morph prototype needs one subtraction for a shared phase, not a new playhead model.

### 5. Param contract — deferred

Deferred until a feature needs position or length as real params, or Float32 precision problems show up; none so far, including for 6A. Replace the paired `loopStart`/`loopEnd` AudioParams with position and length, which removes the Float32 tolerance workaround in move detection. This changes what the engine reads, not only the main thread, and is the largest test churn (about 220 references). The public `SamplePlayer` API can stay as it is.

### 6. Features

Next up. Prototype each on a branch in the JS engine. Order is a suggestion.

- **A. Morphing:** in the oscillator regime, crossfade between window positions at the same phase. Start from the prototype in [#151](https://github.com/KristinnRoach/web-audio/pull/151) (conflicts with `main`, use as reference). The same-phase move fade and its latch are on `main`; morphing adds frames and a morph amount on top.
  - Keep position glide (`setLoopPositionGlide`, default 0) as an option: its tape-like pitch bend while the loop moves is intended.
- **C. Anti-aliasing:** add a seam for how heads read the source, then choose between band-limited copies per octave and a filtered kernel. Start from `prototype/rate-8-loop-prefilter`. Done after A because the two interact: moving between band-limited tables at audio rate [can add sidebands](https://www.kvraudio.com/forum/viewtopic.php?p=8105138) (forum source, verify when we get there).
- **B. Granular:** more heads with window envelopes, for timestretch modes and simple creative effects, detune and widening.
- **D. Audio-rate modulation:** sampler envelopes already run on the audio thread, including loop sync; idle range reports no longer drive their timing. Move selected modulators there when needed. Loop position moves latch to one fade at a time (`LOOP_MOVE_FADE_SECONDS` in `voice-engine.js`), so continuous position modulation needs its own path, such as a morph amount, not more moves.

### 7. Port

Not needed for the features. Answer these before porting, in order, since each answer can change or cancel the ones below it. The render tests provide the reference output.

| #   | Question                                                                                                                                                                                 | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | How should web and native share DSP? One native core compiled to WASM, separate JS and native engines checked against shared renders.                                                    | None       |
| 2   | Is keeping the JS engine beneficial after a port? Weigh fast prototyping, fallback and reference output against maintaining two engines.                                                 | 1          |
| 3   | If there is a native core, Rust or C++? Compare WASM, plugin and hardware tooling.                                                                                                       | 1          |
| 4   | Where does sample memory live, and is `SharedArrayBuffer` needed? Compare per-voice copies, one shared store and shared memory, including the cross-origin isolation cost for consumers. | 1          |
| 5   | What engine boundary does this need? Run a small throwaway spike outside the refactor to check bundling, memory and CPU against JS.                                                      | 3, 4       |
| 6   | Port before or after the features?                                                                                                                                                       | 2, 5       |

### Port-ready rules

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
      loop-window.js              # resolved start, length, direction and regime
      loop-length.js              # quantize, glide, keytrack, drift
      loop-edges.js               # existing
      loop-crossfade.js           # existing
      period-lock-stretch.js      # existing
    test/
  shared/
    dsp/                          # used by more than one processor, or clearly generic
      interpolate.js
      glide.js
      findNearestZeroCrossing.js  # moved from shared/utils
```

Features add files only when they arrive, such as `engine/morph.js`, `engine/grains.js` and `engine/source-reader.js`. Move something to `shared/` once it is clearly generic, not in anticipation.

## Voice ownership — in progress

one processor per `SamplePlayer` owns the shared sample, allocation, note scheduling, pitch and envelopes. `SamplePlayer` keeps the last reported note per voice. Per-voice filters, AM and feedback remain in main-thread `VoiceEffects`; AM and feedback follow note reports. Next migration steps move these effects into the engine, then mix voices to one stereo output and delete `VoiceEffects`. See the [voice migration plan](SAMPLE_PLAYER_VOICE_MIGRATION.md) and [processor contract](SAMPLE_PLAYER_PROCESSOR.md).

## Later decisions

Not needed until we reach them:

- Morph frame spacing and whether it snaps to the quantized period
- Anti-aliasing method and memory budget
- Grain count and envelope
- If `detectPitchPeriods` is kept and needs to support long recordings, consider moving to background analysis.
- Hardware board
