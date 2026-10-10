# Handoff: loop-duration quantization (branch `experiment/processor-loop-snap`)

**Next session: start by asking Kiddi what is needed next. Don't assume the plan below is still current.** Confirm in particular:

- whether to build on this experiment or restart the processor-side snapping with a different structure
- which open question below to settle first

## Settled decisions

- **Public API (#3):** `SamplePlayer.getMacro()` and `getMacrosAudioParam()` were removed and released as a patch. `MacroParam` is no longer reachable from outside the package. It was originally meant as "one control driving several params" and ended up loop-snap specific by accident. Its internals stay out of scope until loop handling is settled; delete or refactor afterwards. On this branch `SamplePlayer` no longer uses it.
- **Keep both `ValueSnapper`s for now.** `src/worklets/shared/helpers/ValueSnapper.js` is unused but stays until the #1 work decides between deleting and consolidating with `src/nodes/params/helpers/ValueSnapper.ts`.
- **Crossover vs snapping range (#2, deferred):** these are separate concepts, deliberately set to the same value (`9cc42f6` on main, see `#setPitchPreservationThreshold`). Whether the crossover should become a fixed constant is decided after #1.
- **Direction for #1:** loop quantization moves into the processor so there is one owner of the logic.
  - Stepped snapping in the processor is the core feature. A glide can come from the caller.
  - A continuous, tunable glide inside the processor is wanted. An experimental version exists on this branch (below). The core low-level changes and the decoupling still come first.

## Experimental WIP on this branch (not reviewed, mostly untested)

1. `d4e8c6d` (checkpoint) removed main-thread snapping:
   - `SamplePlayer` no longer uses `MacroParam`.
   - `setLoopPoint` and `scrollLoopPoints` set raw loop points per voice with `voice.setParam`, using `glideTime = loopRampDuration`.
   - `getAudioParam()` returns `null`.
   - `#zeroCrossings` is now unused, which causes a lint warning.
2. `SamplePlayer.setScale` computes periods with `createScale` and `offsetPeriodsBySemitones` into `#loopSnapPeriods`, ignoring `normalize`. `#setPitchPreservationThreshold` sends the longest of them as the threshold, plus `{ type: 'setLoopSnapPeriods', value: periods }`.
3. `sample-player-processor.js`:
   - `setLoopSnapPeriods` stores the periods in samples.
   - `#snapLoopLength` snaps to the nearest period once per block, only when the length is no longer than the longest period.
   - `#glideLoopLength` adds a one-pole glide in the log domain. The time constant is `LOOP_GLIDE_SECONDS`; `0` means stepped. It only glides inside the snapping range and resets on `voice:start`.
   - `#calculateLoopRange` uses both, so the start stays fixed and the end moves.
   - The audible results are promising, but Kiddi hasn't reviewed the code yet. `LOOP_GLIDE_SECONDS` is a time constant, not an arrival time (~95% after 3x).
4. Testing values to set before merging (the first two are marked `// ! Testing`):
   - the `loopRampDuration` default is `0.001`
   - the `loopStart` and `loopEnd` curves are `4`
   - the default scale is `[0]`, and its "Major" comment is a leftover
5. `SamplePlayer.test.ts` fails: the test expects the threshold message to be sent last.
6. Processor edits only take effect after `vp run build:worklets` (or `vp run watch:processors`).

## Open questions

- Removing the threshold message (the processor can compute the longest period itself).
- Which loop point moves when the length snaps. The experiment keeps the start fixed.
- UI readout: `loop-points:updated` will report raw values once only the processor knows the snapped ones.
- `#loopTempoSync` in `SamplePlayer.setLoopPoint` is always `false`, so those branches are dead code. Tempo quantization already lives in the processor (`#quantizeLoopDuration`).
- Glide design: review and refine the experimental version, and decide how to expose it.
