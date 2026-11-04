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

### 1. Safety net

- Add render tests through `process()` output, only where behavior isn't already pinned: moving quantized loops, ping-pong, stretch.
- Add a simple 16-voice timing baseline. None exists today, and the code already records one audio-thread overrun.

### 2. Cleanup

Remove these first, since each one makes the later steps smaller. Tag before removing anything you may want back.

| Item                   | Action                           | Reason                                                                                                                                                                 |
| ---------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple audio buffers | Remove, down through `loadAudio` | Half-built: zero crossings and the stretcher only read `audioData[0]`. Consumers can layer two voices, each with its own controls, at the cost of twice the voice CPU. |
| Tempo sync             | Remove and tag                   | Unused so far. Returns as one pure length stage. Check other `setTempo` users first.                                                                                   |

### 3. Needs research

Answer in this order, since each answer can change or cancel the ones below it. Nothing here is decided yet.

| #   | Question                                                                                                                                                                                 | Depends on | Blocks           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| 1   | How should web and native share DSP? One native core compiled to WASM, separate JS and native engines checked against shared renders, or a DSP language such as Faust or Cmajor.         | None       | Everything below |
| 2   | Is keeping the JS engine beneficial after a port? Weigh fast prototyping, fallback and reference output against maintaining two engines.                                                 | 1          | 6, steps 6 and 7 |
| 3   | If there is a native core, Rust or C++? Compare WASM, plugin and hardware tooling.                                                                                                       | 1          | 5, step 7        |
| 4   | Where does sample memory live, and is `SharedArrayBuffer` needed? Compare per-voice copies, one shared store and shared memory, including the cross-origin isolation cost for consumers. | 1          | 5, step 4        |
| 5   | What engine boundary does this need? Run a small throwaway spike outside the refactor to check bundling, memory and CPU against JS.                                                      | 3, 4       | Step 4           |
| 6   | Port before or after the features?                                                                                                                                                       | 2, 5       | Steps 6 and 7    |

### 4. Split, then simplify

1. **Shell and engine:** the processor keeps only messages, params and `process()`. The engine gets `sampleRate`, time and random values passed in, with no AudioWorklet globals.
2. **Pure stages:** pull out quantize, glide, keytrack and drift as small functions.
3. **Core model:** apply the three ideas above and collapse the heads into one list.
4. **Playhead as an offset from the window start (oscillator regime):** try this here. Window moves would no longer need the carry logic, and morphing needs a shared phase anyway. Drop it if it doesn't simplify things.

### 5. Param contract

Replace the paired `loopStart`/`loopEnd` AudioParams with position and length, which removes the Float32 tolerance workaround. This is the largest test churn (about 220 references), so it comes after the model has settled. The public `SamplePlayer` API can stay as it is.

### 6. Features

Prototype each on a branch against the stable core. Order is a suggestion.

- **A. Morphing:** in the oscillator regime, crossfade between window positions at the same phase. Start from the ideas in `proto/loop-move-latch`.
- **C. Anti-aliasing:** add a seam for how heads read the source, then choose between band-limited copies per octave and a filtered kernel. Start from `prototype/rate-8-loop-prefilter`. Done after A because the two interact: moving between band-limited tables at audio rate [can add sidebands](https://www.kvraudio.com/forum/viewtopic.php?p=8105138) (forum source, verify when we get there).
- **B. Granular:** more heads with window envelopes, for stretch modes and simple creative effects, detune and widening. Could replace `SpliceStretcher` if it sounds better.

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
      read-heads.js               # playhead and outgoing heads, replaces loop-crossfade.js
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
