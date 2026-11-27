# Sample player roadmap

Goal: a small, stable sampler core that morphing, granular and anti-aliasing can build on, and that can later serve as a starting point for hardware, native apps and plugins (VST, CLAP). The web-audio library must keep working throughout.

## Core model

How the voice works today:

1. **Passes:** a note is a sequence of passes: from the note start toward the trim end, then one per loop cycle. Each loop pass plays the latched `LoopWindow` (`start`, `length`, requested `direction`), latched when the playhead reaches the loop and at every wrap or turn. Pass ends are shrink only.
2. **Pitch loop vs time loop,** decided once per window:
   - **Pitch loop:** quantize, length and position glide. Morphing goes here.
   - **Time loop:** keytrack, zero-crossing snap, tempo sync later.
3. **Grains:** the playhead is the current grain; every edge (wrap, turn, trim end) fades an outgoing grain. Grains and the stretcher's fade head mix in one list of read heads, each reading the source through a `SourceReader` and an interpolation kernel.

Features that need the source buffer or playhead live in the voice; audio-in, audio-out effects can be separate processors. Add engine files when a feature arrives, and move code to `shared/` only once it is clearly generic.

## Steps

Each step is one or more small PRs with no audible change, unless noted.

1. **Safety net — complete:** render tests and a 16-voice timing baseline ([baseline](SAMPLE_PLAYER_BASELINE.md)).
2. **Cleanup — complete:** removed multiple-buffer playback and tempo sync; preserved in the `sample-player-before-cleanup` tag.
3. **Research — moved** to step 7.
4. **Split, then simplify — complete:** the voice has no AudioWorklet globals, pure loop stages, one read-head list and a `LoopWindow` ([#145](https://github.com/KristinnRoach/web-audio/pull/145)–[#149](https://github.com/KristinnRoach/web-audio/pull/149)). Loop changes latch at the next wrap or turn ([#214](https://github.com/KristinnRoach/web-audio/pull/214)).

### 5. Loop phase and grains — in progress

Engine only; the `SamplePlayer` API stays as it is. Modelled on [Spotykach](https://github.com/Synthux-Academy/Spotykach) (MIT, C++ on the Daisy Seed).

- Replace the absolute playhead with a loop anchor plus a phase within the latched loop window.
- Make every read head a grain, so granular becomes more grains.
- Play normal playback and loops as one system: a note is a sequence of passes (from the note start, then each loop pass), with the same edge fade and one direction model.
- Pass ends are shrink only: an edit can pull the current pass's end in (fading out if the playhead is already past it), not push it out. Keep the end editable mid-pass, so a live end can be added later.
- Open: the boundary between time loops and pitch loops should need no special case to cross smoothly.

### 6. Features

After step 5. Prototype each on a branch. Order is a suggestion.

- **A. Morphing:** for pitch loops, crossfade between window positions at the same phase. Reference: [#151](https://github.com/KristinnRoach/web-audio/pull/151) (conflicts with `main`). Keep position glide (`setLoopPositionGlide`, default 0) as an option: its tape-like pitch bend is intended.
- **C. Anti-aliasing:** Hermite and band-limited sinc kernels landed in [#162](https://github.com/KristinnRoach/web-audio/pull/162). Remaining: loop-aware source reads (short loops can read past their edges) and handling rates above 8, where sinc stops widening; start from `prototype/rate-8-loop-prefilter`. After A, since moving between band-limited tables at audio rate [can add sidebands](https://www.kvraudio.com/forum/viewtopic.php?p=8105138) (forum source, verify).
- **B. Granular:** more grains, for timestretch modes and simple effects such as detune and widening. Started: grain timestretch (a hop scheduler).
- **D. Audio-rate modulation:** move selected modulators to the audio thread when needed. Loop moves apply once per pass, so continuous position modulation needs its own path, such as a morph amount.

### 7. Port

Not needed for the features. Answer these in order, since each answer can change or cancel the ones below it. The render tests provide the reference output.

| #   | Question                                                                                                                                                                                 | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | How should web and native share DSP? One native core compiled to WASM, separate JS and native engines checked against shared renders.                                                    | None       |
| 2   | Is keeping the JS engine beneficial after a port? Weigh fast prototyping, fallback and reference output against maintaining two engines.                                                 | 1          |
| 3   | If there is a native core, Rust or C++? Compare WASM, plugin and hardware tooling. Spotykach is one C++ reference, not a decision.                                                       | 1          |
| 4   | Where does sample memory live, and is `SharedArrayBuffer` needed? Compare per-voice copies, one shared store and shared memory, including the cross-origin isolation cost for consumers. | 1          |
| 5   | What engine boundary does this need? Run a small throwaway spike outside the refactor to check bundling, memory and CPU against JS.                                                      | 3, 4       |
| 6   | Port before or after the features?                                                                                                                                                       | 2, 5       |

Port-ready rules:

- The voice doesn't touch `port`, `currentTime` or `sampleRate` globals.
- No allocation while rendering: preallocate, and use plain numbers and typed arrays.
- No JS-specific tricks in DSP code.

## Voice ownership — in progress, not blocking

One processor per `SamplePlayer` owns the sample, allocation, notes, pitch and envelopes. Remaining: move per-voice effects (`VoiceEffects`) into the engine, then mix voices to one stereo output. See the [voice migration plan](SAMPLE_PLAYER_VOICE_MIGRATION.md) and [processor contract](SAMPLE_PLAYER_PROCESSOR.md).

## Later decisions

Not needed until we reach them:

- Morph frame spacing, and whether it snaps to the quantized period
- Anti-aliasing method and memory budget
- Grain count and envelope
- Live pass ends: let edits also push the current pass's end out, if shrink only stops being enough (reference: `prototype/time-loop-mid-pass-edits`)
- Background analysis for `detectPitchPeriods`, if it is kept and must handle long recordings
- Splitting state machines out of `SamplePlayerVoice` (loop glides, drift, range reporting) if it gets crowded or before porting
- Hardware board
