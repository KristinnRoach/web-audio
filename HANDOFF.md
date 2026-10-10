# Handoff: loop-duration quantization (branch `experiment/processor-loop-snap`)

**Next session: start by asking Kiddi what is needed next. Don't assume the plan below is still current.** Confirm in particular:

- whether to build on this experiment or restart the processor-side snapping with a different structure
- which open question below to settle first

## Settled decisions

- **Public API (#3):** `SamplePlayer.getMacro()` and `getMacrosAudioParam()` were removed and released as a patch. `MacroParam` is no longer reachable from outside the package. It was originally meant as "one control driving several params" and ended up loop-snap specific by accident. Its internals stay out of scope until loop handling is settled; delete or refactor afterwards.
- **Keep both `ValueSnapper`s for now.** `src/worklets/shared/helpers/ValueSnapper.js` is unused but stays until the #1 work decides between deleting and consolidating with `src/nodes/params/helpers/ValueSnapper.ts`.
- **Crossover vs snapping range (#2, deferred):** these are separate concepts, deliberately set to the same value (`9cc42f6` on main, see `#setPitchPreservationThreshold`). Whether the crossover should become a fixed constant is decided after #1.
- **Direction for #1:** loop quantization moves into the processor so there is one owner of the logic.
  - Stepped snapping in the processor is the core feature. A glide can come from the caller.
  - A continuous, tunable glide inside the processor is wanted later. Do the core low-level changes and the decoupling first.

## Experimental WIP on this branch (not reviewed, not tested)

1. `SamplePlayer.ts`: the default scale is `[0, 2, 4, 5, 7, 9, 11]` (major) instead of `[0]`. This was changed for listening and is not a decided default.
2. `SamplePlayer.#setPitchPreservationThreshold` also sends `{ type: 'setLoopSnapPeriods', value: periods }`, taking the periods from the loop-end macro's snapper. It assumes `normalize: false`, so with a normalized scale the periods are wrong.
3. `sample-player-processor.js`:
   - The `setLoopSnapPeriods` handler stores the periods in samples (`this.loopSnapPeriods`).
   - The new `#snapLoopLength` snaps to the nearest period on every block, but only when the length is no longer than the longest period.
   - `#calculateLoopRange` uses it for `loopLength`, so the start stays fixed and the end moves.
4. Main-thread snapping (`MacroParam`) is still active, so snapping happens twice. Result: a static loop sounds unchanged, and a loop-point ramp now jumps through the scale notes instead of sliding. `loopRampDuration` controls when the jumps happen and how fast they come, not how smooth they are.
5. `SamplePlayer.test.ts` fails: the test expects the threshold message to be sent last.

## Open questions

- How periods reach the processor: computed directly from the scale (`createScale`) rather than read from the macro's snapper. This also makes the `normalize` assumption go away.
- Removing main-thread period snapping and the threshold message (the processor can compute the longest period itself).
- Which loop point moves when the length snaps. The experiment keeps the start fixed.
- UI readout: `loop-points:updated` will report raw values once only the processor knows the snapped ones.
- `#loopTempoSync` in `SamplePlayer.setLoopPoint` is always `false`, so those branches are dead code. Tempo quantization already lives in the processor (`#quantizeLoopDuration`).
- Design of the continuous glide in the processor (later).
