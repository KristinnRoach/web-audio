# Handoff: loop-duration quantization (branch `experiment/processor-loop-snap`)

**Next session: start by asking Kiddi what is needed next. Don't assume the plan below is still current.** Confirm in particular:

- whether to build on this experiment or restart the processor-side snapping with a different structure
- which open question below to settle first

## Settled decisions

- **Public API (#3):** `SamplePlayer.getMacro()` and `getMacrosAudioParam()` were removed and released as a patch. `MacroParam` is no longer reachable from outside the package. It was originally meant as "one control driving several params" and ended up loop-snap specific by accident. Its internals stay out of scope until loop handling is settled; delete or refactor afterwards. On this branch `SamplePlayer` no longer uses it.
- **Keep both `ValueSnapper`s for now.** `src/worklets/shared/helpers/ValueSnapper.js` is unused but stays until the #1 work decides between deleting and consolidating with `src/nodes/params/helpers/ValueSnapper.ts`.
- **Crossover vs snapping range (#2, deferred):** these are separate concepts, deliberately set to the same value: the processor sets `PITCH_PRESERVATION_THRESHOLD` to the longest snap period on `setLoopSnapPeriods`. Whether the crossover should become a fixed constant is decided after #1.
- **Direction for #1:** loop quantization moves into the processor so there is one owner of the logic.
  - Stepped snapping in the processor is the core feature. A glide can come from the caller.
  - A continuous, tunable glide inside the processor is wanted. An experimental version exists on this branch (below). The core low-level changes and the decoupling still come first.

## Experimental WIP on this branch (not reviewed, mostly untested)

1. `d4e8c6d` (checkpoint) removed main-thread snapping:
   - `SamplePlayer` no longer uses `MacroParam`.
   - `setLoopPoint` and `scrollLoopPoints` set raw loop points per voice with `voice.setParam`, with no main-thread ramp.
   - `getAudioParam()` returns `null`.
2. `SamplePlayer.setScale` computes periods with `createScale` and `offsetPeriodsBySemitones` into `#loopSnapPeriods` (sorted ascending, in seconds) and sends them as `{ type: 'setLoopSnapPeriods' }`. The processor derives the threshold from the longest. `setScale` validates its options (throws `RangeError`); `normalize` is gone.
3. `sample-player-processor.js`:
   - `setLoopSnapPeriods` stores the periods in samples.
   - `#snapLoopLength` snaps to the nearest period once per block, only when the length is no longer than the longest period.
   - `#glideLoopLength` adds a one-pole glide in the log domain. The time constant is `loopRampDuration`, sent from the `loopRampDuration` sampler param via `setLoopRampDuration`; `0` means stepped. It only glides inside the snapping range and resets on `voice:start`.
   - `#calculateLoopRange` uses both, so the start stays fixed and the end moves.
   - The audible results are promising, but Kiddi hasn't reviewed the code yet. `loopRampDuration` is a time constant, not an arrival time (~95% after 3x).
4. Testing values to set before merging (the first one is marked `// ! Testing`):
   - the `loopStart` and `loopEnd` curves are `4`
   - the default scale is `[0]`, and its "Major" comment is a leftover
5. Processor edits only take effect after `vp run build:worklets` (or `vp run watch:processors`).

## Rebased onto main after #99 (2026-10-14)

- Grouped into 3 commits (the processor loop-snap one is left uncommitted for the ear test); the original 17 are tagged `backup/processor-loop-snap-pre-rebase` (local) and listed in the Traycer ticket `rebase-loop-snap-onto-main`.
- Loop points are stored raw (#99). `#calculateLoopRange`: min/max order, floor at 1 sample, snap, glide, shift into the trim range, `resolveRange` with a 1-sample minimum. The loop floors at 1 sample with a scale set (snapping lifts it) and at `MIN_RANGE_SAMPLES` (C5) without one. Trim keeps the C5 minimum.
- `#zeroCrossings` (unused) removed.

- Audio-rate loops: the playhead moves with the loop start so moving loops keep their period. An occasional glitch on fast zooming remains: see the Traycer ticket `fix-loop-glitch-on-fast-point-updates`.

## Open questions

- Which loop point moves when the length snaps. The experiment keeps the start fixed.
- UI readout: `loop-points:updated` will report raw values once only the processor knows the snapped ones.
- Glide design: review and refine the experimental version, and decide how to expose it.
