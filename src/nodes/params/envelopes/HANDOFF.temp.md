# Envelope module — handoff

Temporary. Delete once the module structure and API are settled.

Finalize the envelope module structure and API in `src/nodes/params/envelopes/`.

**GOAL (unchanged):** delete `EnvelopeRuntime` and expose the public API through the
`Envelope` class. Keep things simple and decoupled. Callers get aligned to the final
API, not designed around.

## Current files

```
Envelope.ts             402  EnvelopeClock, EnvelopeTriggerOptions, EnvelopePlayer,
                             module-global loop refill registry (addLoop/setInterval),
                             class Envelope, createEnvelope
envelope-scheduling.ts  165  AutomatableParam, ScheduleOptions, schedulePoint, valueOf,
                             scheduleRange, floorOffZero, scheduleEnvelope, releaseEnvelope
envelope-config.ts       38  EnvelopeConfig, cloneEnvelopeConfig, assertValidEnvelopeConfig
envelope-shape.ts       280  shape types, validation, pure math, point editing
envelope-presets.ts      67
EnvelopeRuntime.ts      130
index.ts                  6  barrel, `export *` from all of the above
```

## What remains in EnvelopeRuntime

Non-passthrough: stored `EnvelopeConfig` ownership; the
`Math.max(clock.currentTime, startTime)` clamp in `trigger`/`release`; creating a NEW
`Envelope` player on every trigger and stopping the old one at the handover.

Everything else is a getter (`config`/`enabled`/`loop`) or a forward to `#envPlayer`
(`currentPoint`, `nextCycleTime`, `setSustainValue`, `dispose`), plus
`duration`/`releaseDuration`, which branch idle-vs-live.

## Blocker for the lifecycle merge (verified, easy to miss)

`EnvelopeRuntime` has NO `stop()`. Its only teardown method is `dispose()`, and it is
**reusable**: it disposes the inner player, nulls it, and the next `trigger()` builds a
fresh one.

`SampleVoice.#stopEnvelopes()` (`SampleVoice.ts:485`) calls `env.dispose()` and runs on
every `#transitionTo(VoiceState.AVAILABLE)` — voice returned to the pool — and the voice
is re-triggered afterwards.

`Envelope.dispose()` is TERMINAL: sets `#disposed`, and `trigger()` throws
`'Cannot trigger a disposed EnvelopePlayer'`.

So the merge must re-separate `stop()` (ends the run, object reusable) from `dispose()`
(terminal), and repoint `SampleVoice.ts:486` at `stop()`. The other three sites need
deciding individually: `SampleVoice.ts:231` in `#createEnvelopes`, `:736` on the
enabled→disabled transition, `:1235` in `dispose()`.

## Verified: the two-player handover is redundant

Probe compared today's handover against re-triggering ONE player, same scenario as the
"re-triggers at the boundary" test (loop 0/1/2, trigger at 0, re-trigger at 2 from
`currentTime` 0.5):

```
two-player:  cancel@2  set 0@2  cancel@2  set 0@2  linear 1@3  linear 0@4
single:      cancel@2  set 0@2                     linear 1@3  linear 0@4
```

Identical minus one `setValueAtTime` that the following `cancelScheduledValues` wipes
(the runtime's own comment already calls that pin pointless).

Re-trigger is safe: `Envelope.trigger` calls `#stopLoop()` first and captures fresh
locals for base/amount/timeScale/shape, so the refill closure cannot read a later
trigger's values.

## Param binding

`EnvelopeRuntime.trigger` takes the param per call; `Envelope` binds it at construction.
`SampleVoice` looks up the same param object every trigger (`SampleVoice.ts:433`), so
constructor binding matches actual usage.

## timeScale

`EnvelopeRuntimeTriggerOptions.timeScale` is REQUIRED and caller-composed
(`config.timeScale * multiplier`). `SampleVoice.#timeScale` is the only live composer.
`duration(timeScale)` / `releaseDuration(timeScale)` default to `config.timeScale` and
ignore the argument entirely while a player is live.

## Config and presets — decided, fold into the merge

`EnvelopeConfig = { enabled, timeScale, envelope }`. Verified: `Envelope.ts`,
`envelope-scheduling.ts` and `envelope-shape.ts` mention `EnvelopeConfig` **zero** times.
Its only consumers are `EnvelopeRuntime` (being deleted) and `envelope-presets.ts`.

**`enabled`** — no scheduling code reads it. Readers are the validator, the
`EnvelopeRuntime.get enabled()` passthrough, and Sample-layer decisions
(`adapters.ts:51` `shouldTriggerSampleEnvelope`; `SampleVoice.ts:528`, `:540`, `:734`).
It is already stored caller-side in `SamplePlayer.envelopeConfigs`
(`SamplePlayer.ts:72`) and cloned again into every voice's `EnvelopeRuntime`, so
relocating it deletes a duplicate rather than creating work.

**`timeScale`** — no production code ever stores a value other than 1. Every assignment
in the repo is `1` (the three presets) or a test (`SamplePlayer.test.ts:7` uses 2,
`:124` uses 0 to assert rejection). There is no public setter; the only way in is a
caller passing one to `applyEnvelopeConfig`. Since the live multiplier became a
per-trigger option, the stored field is only a default for
`duration()`/`releaseDuration()`.

**Decision: do NOT move `EnvelopeConfig` separately.** It cannot move while
`EnvelopeRuntime` stores it — the envelope module would import from `instruments/Sample`,
inverting the dependency. Both changes rewrite the same three surfaces
(`EnvelopeRuntime` members, `SampleVoice` call sites, `EnvelopeRuntime.test.ts`'s
`configOf()` fixture), so sequencing them pays for those twice. Move it to the Sample
layer as part of the merge; `enabled` and `timeScale` then end up caller-side by
construction.

**Presets stay in the module.** The shapes are generic and a future synth would want
them; the `amplitude`/`pitch`/`filter` ↔ `amp-env`/`pitch-env`/`filter-env` name match is
coincidence, not coupling. Only the two wrapper fields are host policy. Change
`envelope-presets.ts` to return `EnvelopeShape` instead of `EnvelopeConfig`, and move the
`enabled` defaults (amp true, pitch false, filter false) into
`createDefaultSampleEnvelopeConfig` (`adapters.ts:25`), which already switches per id.

Churn for that: return type plus unwrapping three object literals in
`envelope-presets.ts`; three `enabled` values added to the adapter switch; unwrapping one
expectation in `test/envelope-presets.test.ts:6`.

Open, blocks nothing: `pitch()` returns two points both at value 1 — a flat line. With
the wrapper gone it is an identity placeholder, and `shouldTriggerSampleEnvelope` already
refuses a pitch env with no variation via `hasVariation`. May belong in the adapter
rather than as a preset.

## Caller state

`SampleVoice` is the ONLY live caller. `InstrumentBus` usage is commented out under
`// TODO: @POST_ENV_API_READY` (commit b47dc5c) — leave it commented; restore it against
the final API. It causes two pre-existing lint warnings (`DEFAULT_FILTER_ENV_AMOUNT` in
`SamplePlayer.ts:54`, `midiToPlaybackRate` in `InstrumentBus.ts:10`) — do not "fix" them
by deleting. `temporary-sample-envelope-adapters.ts` holds the Sample-specific glue.

## Error messages

`assertValidEnvelopeConfig` throws `'Invalid envelope settings'`.
`assertValidEnvelopeShape` throws `'Invalid envelope'`.
`EnvelopeRuntime.trigger` uses the shape one; constructor and `update` use the config one.

## Changesets

`@kidlib/web-audio` is published (0.4.2) and `src/index.ts` exports `EnvelopeConfig`,
`assertValidEnvelopeConfig`, `cloneEnvelopeConfig` and `envelopePresets`, so this work
breaks the public API. Changesets deliberately deferred — reconcile at the end.

## Tooling (easy to get wrong)

```
format   npx vp fmt <paths>     oxfmt; singleQuote set in vite.config.ts
test     npx vp test run
lint     npx vp lint
types    npx tsc --noEmit
```

There is no prettier config — running prettier reformats the repo to double quotes.

`tsconfig.json` excludes `"src/**/*.test*"`, so `tsc --noEmit` does NOT typecheck test
files. Always run the test suite.

A lint-staged pre-commit hook runs `vp check --fix` and can modify staged files.

## Baseline

286 tests pass, 1 skipped; tsc and lint clean at `d2ae09a`.
`TODO.md` in this folder tracks deferred items including an open loop-drift
investigation.
