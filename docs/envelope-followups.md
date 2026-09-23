# Envelope consolidation: deferred work

Left over from #60. Each bullet is a claim to verify against the code it points at,
not a decision already made. Order is roughly by risk, not by effort.

## Note ownership

- `SamplePlayer` releases one voice per pitch, `InstrumentBus` counts note-ons. The pedal
  path now unwinds the bus count per release. That loop is mostly unreachable, since the
  pedal turns hold mode on and `release()` returns early while hold is on; it does run if
  the host toggles hold off while the pedal is down, and there the counting is a real fix.
  Tracked in #67. `SamplePlayer.ts:637,780,817`, `InstrumentBus.ts:339,375`.
- A surplus `outBus.noteOff` is inert: `InstrumentBus.noteOff` returns on an unknown count
  before the `size === 0` check, so it cannot fire the envelope release early.
  `InstrumentBus.ts:376`.
- `voicePool.noteOff` releases every voice at a pitch at once, so a doubled pitch cannot
  be released one voice at a time. `SampleVoicePool.ts:194`.

## Envelope core

- The release stage deliberately binds at trigger. Editing it mid-note affects the next
  trigger, like other definition changes; `setSustainValue()` is the explicit live
  exception. `docs/envelope-live-edit.md:34`.
- `Envelope.release` is required. Presets default it to the second-last point. Decide
  whether an envelope without a release stage is expressible.
- Coincident point times are now rejected on insert (#60) to match `updatePoint`'s strict
  ordering. The player and interpolation still tolerate them, so a shape built by other
  means can carry them. `envelope-shape.ts:43,72`.
- Loop-on mid-attack snaps to a point rather than splitting the segment, so a toggle mid
  segment is off by up to one segment. See `EnvelopePlayer.currentPoint()`.
- Release pins a value instead of `cancelAndHoldAtTime` (Firefox gap). Revisit when that
  lands. See `releaseEnvelope()` and `EnvelopePlayer.release()`.

## Sampler policy

- `temporary-sample-envelope-adapters.ts` still holds sampler IDs, defaults,
  target selection, value mapping and timing policy. Dissolve into the caller or promote
  into the core; the file name is the only thing marking it as temporary.
- Live edits to a non-looping run, and to a held note's sustain _index_, wait for the next
  trigger. No inaudible seam exists for either. `docs/envelope-live-edit.md:178`.
- The temporary sampler adapter skips live sustain forwarding for a filter envelope whose
  stored values are normalized but whose active player shape is mapped to Hz.

## Tests

- The pedal repeat-release fix has no test. A unit test needs a constructed `SamplePlayer`;
  the private fields make `Object.create(prototype)` call sites throw, and no harness builds
  a real one. Either add a browser test or extract the sustain bookkeeping.
- `fakeParam` no longer records `setValueCurveAtTime`. Fine while `AutomatableParam`
  excludes curves; revisit if the player starts scheduling them. See `test/fakeParam.ts`.

## Hygiene

- Unrelated TODOs in files this PR touched: `SamplePlayer.ts:110` (loop tempo sync),
  `SamplePlayer.ts:1028` (envelope source of truth), `SampleVoice.ts:90` (#31),
  `Preprocessor.ts:38` (compression).
