# A-rate loop controls: draft decisions

Draft against main after #109, 2026-10-16. Core processor work is ready for review;
the exploration ticket remains open pending listening, routing and real-time profiling.

## Behavior chosen for this draft

- `loopStart` and `loopEnd` are a-rate, in absolute source seconds. Trim stays
  k-rate. Existing player setters still schedule values on each voice; there is
  no new player-level modulation API.
- Both endpoint values are read at the current audible sample, including a
  scheduled note's offset into a quantum. Point modulation enters **before**
  ordering, minimum length, scale-period snapping and duration glide. Modulating
  a pitched loop therefore selects snapped targets; it does not bypass the scale.
- Keep internal log-duration glide, now advancing once per audible sample rather
  than using a hard-coded 128-frame step. `loopRampDuration` remains a time constant:
  about 95% of a transition after three time constants. Zero means immediate
  snapped steps. New notes and entry into the snapping range start at the target;
  no glide outside that range. The initial target still respects trim capacity.
- Retain the existing order after glide: trim containment, tempo sync, long-loop
  keytracking, then drift and long-loop zero-crossing adjustment. Tempo sync wins
  over keytracking. Both now use the current sample's playback rate. These
  modifiers can still produce off-scale periods or keytracked silence padding.
- Preserve source-coordinate offset while moving short loops, including a
  fractional step that just overshot an edge: carry eligibility uses the last
  rendered position. Do not rescale phase when duration changes. Retain fractional
  periods and existing edge rules. Endpoint crossing changes the requested loop
  type; `loopTurned` survives and the type takes effect at the next edge.
- Reuse a range within a block while endpoints/rate are unchanged, glide is settled
  and no drift update is pending. Re-evaluate each block for messages and trim
  changes. End glide within 1e-12 natural-log units of its target, then pin it,
  so asymptotic glide does not force per-sample resolution forever.
- Drift generation follows loop passes, with the existing short-loop update
  interval. Remove the `loopCount === 0` regeneration exception: per-sample
  resolution must not generate random drift on every sample before the first edge.
  Drift and optional pan drift update on the sample after a passed edge.
- Amplitude makeup remains sampled at the first audible frame of each block.
  Per-sample RMS scans would be costly; this limitation is explicit in the code.
  Duration-preserver eligibility and silence padding follow the current range.
  Backward and ping-pong duration preservation remain disabled.
- `loop:range` reports the final audible frame's effective range, retaining the
  per-voice 30 Hz throttle. It is a UI snapshot, not a modulation trace.

## Explicitly deferred

| Issue                                                         | Reason / next check                                                                                                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope/modulator routing across pooled voices               | A player has no single loop AudioParam; `getAudioParam()` still returns null. Decide voice lifecycle and routing policy before adding an API. Per-voice AudioParams can already be scheduled.                  |
| Listening acceptance                                          | Check pitched glides, rapid targets, moving source timbre, drift and mode changes by ear in the consuming app before merging. No subjective audio-quality claim yet.                                           |
| Browser audio-thread CPU/GC under polyphony                   | Per-sample range resolution allocates objects/arrays and scans scale periods; no claim of allocation-free or bounded worst-case work. Profile realistic scales, channels and buffers before optimizing.        |
| Makeup-gain modulation                                        | Block-rate RMS/makeup can step or lag while the loop moves. Design and measure a gain policy rather than doing an RMS scan per sample.                                                                         |
| Long-loop modulation and duration preservation                | Existing zero-crossing scans can be costly. No dedicated listening/CPU validation of modulated long loops, tempo boundaries, keytracked padding, or preservation transitions; static regression suites pass.   |
| Float32 precision at the longest scale period                 | An exact endpoint can round slightly above the snapping-range ceiling and bypass snapping/glide. Existing boundary behavior remains; settle tolerance separately rather than adding an arbitrary epsilon here. |
| Trim a-rate and atomic range setters                          | Outside this draft. Separate endpoint setters still are not an atomic update.                                                                                                                                  |
| Existing drift-click and backward/ping-pong preservation work | Remains in the handoff; this change does not claim to resolve it.                                                                                                                                              |

## Verification

- `vp install`, `vp check --fix`, `vp test run`, `vp run build`, `vp run test:browser`.
- Node suite: 380 passed, one existing skipped test. Browser suite: 44 passed.
- Regression coverage: full blocks versus one-sample rendering in four modes,
  with zero and nonzero glide; endpoint crossing without resetting a turn;
  fractional overshoot carry; drift generation before the first edge;
  analytical 37-frame glide; trim containment and fractional periods.
- Chrome OfflineAudioContext verifies a scheduled loop-end step at frame 65
  affects a wrap inside the same 128-frame quantum. Browser tests consume the
  built worklet, so build before running them.

### CPU proxy

Measured the bundled processor directly in Node v24.22.0 on Apple M1 Pro,
48 kHz, mono, a one-second sine source, three scale periods (2/4/8 ms),
10 ms glide, default makeup and smoothing, drift off. Each case warms 128 blocks,
then times 1,000 blocks of 128 frames, median of three runs. Output/parameter
buffers are reused; voice calls are serial. Rapid targets alternate 2.1/7.5 ms
requests every four blocks (snapping to 2/8 ms). Moving points translate a
4 ms loop with a 1 ms sinusoidal offset within each block.

Numbers below are elapsed time divided by 2.667 seconds of audio, expressed as a
percentage of one core. This measures relative processor cost, not real-time
browser scheduling, GC pauses, or the rest of an instrument graph. No main-branch
baseline was measured. The temporary measurement script was not added to the
library; this draft adds no benchmark infrastructure.

| Voices | Static           | Rapid targets     | Moving points     |
| ------ | ---------------- | ----------------- | ----------------- |
| 1      | 13.3 ms / 0.50%  | 27.6 ms / 1.03%   | 17.9 ms / 0.67%   |
| 8      | 55.8 ms / 2.09%  | 158.9 ms / 5.96%  | 141.0 ms / 5.29%  |
| 16     | 110.1 ms / 4.13% | 303.5 ms / 11.38% | 291.0 ms / 10.91% |
