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
(terminal) at the call sites. See step 1 under "Suggested lifecycle merge" for the
per-site triage.

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

## Suggested lifecycle merge

The mechanical part: `Envelope` takes `(clock, param, shape)`, `trigger` drops its param
argument, the four `#envPlayer?.x()` forwards disappear, and `EnvelopeRuntime` is
deleted. These are the parts that need judgment.

**1. Triage the four `.dispose()` sites. TWO must become `stop()`, not one.**
`Envelope` already has both methods separated correctly; the work is entirely
caller-side.

```
SampleVoice.ts:231   #createEnvelopes()      map is replaced        -> dispose()
SampleVoice.ts:486   #stopEnvelopes()        voice reused           -> stop()
SampleVoice.ts:736   applyEnvelopeConfig()   can be re-enabled      -> stop()
SampleVoice.ts:1235  SampleVoice.dispose()   terminal               -> dispose()
```

`:736` runs on the enabled→disabled transition. The voice keeps living and the envelope
can be re-enabled and re-triggered later, so a terminal `dispose()` there throws on the
next note. This one is easy to miss; the earlier handoff text only named `:486`.

**2. Resolve the public name collision before exporting the class.**
`src/index.ts:23` exports `EnvelopeShape as Envelope` — the package's public `Envelope`
type currently means the _shape_, not the player. Pick which one keeps the name.

**3. Decide where the param lookup happens.**
`Envelope` binds the param at construction, but `#createEnvelopes()` (`SampleVoice.ts:230`)
builds envelopes without one. `SampleVoice.getParam` (`:1241`) returns null for `'lpf'`
until `#lpf` exists, and `#triggerEnvelope` guards with `if (!param) return`, so null is
reachable at trigger time today. Verify all three ids resolve at both `#createEnvelopes()`
call sites (`:138` during init, `:974` on `voice:loaded`). If any can be null there,
construct the player lazily on first trigger and keep the guard.

**4. Give SampleVoice somewhere to read `enabled`.**
Three sites read it off the runtime (`:528`, `:540`, `:734`). `applyEnvelopeConfig`
(`:725`) already receives the config but does not store it. `:734` compares the live
value against the incoming one to detect the disable transition, so it needs the
_previous_ value, not just the new one — a plain "read the incoming config" substitution
breaks it.

**5. Decide the idle default for `duration()` / `releaseDuration()`.**
They currently default to `config.timeScale`. With the config gone there is no stored
scale. `SampleVoice.releaseTime` (`:1080`) calls `releaseDuration()` with no argument,
while `:456` and `:546` pass a composed scale. Either make the argument required and fix
`:1080`, or default to 1 and accept that `:1080` changes meaning.

**6. Moving the clamp changes `Envelope`'s behavior for direct callers.**
`Math.max(clock.currentTime, startTime)` lives in `EnvelopeRuntime.trigger`/`release`;
`Envelope.trigger` takes `time` as given. Check `test/Envelope.test.ts` before moving it —
those tests trigger at explicit timestamps against a fake clock.

**7. Port the handover tests, do not delete them.**
`test/EnvelopeRuntime.test.ts` is ~250 lines built on the `configOf()` fixture. The
`live config handover` and `repeated handovers` describes are what pin the behavior this
merge changes. Rewrite them against the merged class.

**8. Delete the `EnvelopePlayer` type.**
Once `Envelope` is the API it is a structural type with one implementation.

**9. Fold in the config move** as described under "Config and presets" above.

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
