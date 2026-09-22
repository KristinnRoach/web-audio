# Envelope module — handoff

Temporary. Delete once the module API is settled.

**Goal:** a clean, reusable envelope API in `src/nodes/params/envelopes/`. Callers are
aligned to the final API afterwards, not designed around.

## Current files

```
Envelope.ts             EnvelopeClock, EnvelopeTriggerOptions, EnvelopePlayer,
                        module-global loop refill registry, class Envelope, createEnvelope
envelope-scheduling.ts  AutomatableParam, ScheduleOptions, param-writing primitives
envelope-shape.ts       shape types, validation, pure math, point editing
envelope-presets.ts     amplitude/pitch/filter, each returns an EnvelopeShape
index.ts                explicit exports: everything used outside the module
```

## Current API

```ts
const env = createEnvelope(clock, param, shape); // validates and copies the shape
env.trigger(time?, { base, amount, timeScale, fromPoint, shape? }); // shape? = this run only
env.release(time?);
env.stop(time?); // ends the run, player stays reusable
env.shape = edited; // next trigger plays it; the live run keeps its copy
env.duration(); env.releaseDuration(); // latest run, or stored shape at scale 1 before any
env.position(); env.currentPoint(); env.nextCycleTime(); env.setSustainValue(v);
```

`trigger`/`release` clamp `time` to `clock.currentTime`. Re-triggering one player is the
handover: a trigger at a future cycle boundary leaves the playing cycle alone. Pinned by
the "re-triggering one player" tests in `test/Envelope.test.ts`.

## Open

1. **`EnvelopePlayer` type.** Structural type with one implementation. `class Envelope` is
   not exported; `createEnvelope` returns the type. The `Envelope` public name is free now,
   so decide: export the class and delete the type, or keep factory + type. The class doc
   justifies the type with `observeEnvelopePlayer`, which only exists in
   `EnvelopePlayerObserver.temp.txt` (not compiled; still calls the removed `dispose()`).
2. **`pitch()` preset** is a flat line (two points at value 1), an identity placeholder.
   `shouldTriggerSampleEnvelope` already skips a pitch env with no variation. May belong
   in the Sample adapter instead.
3. **Ear test** the single-player re-trigger in the sampler before relying on it. The probe
   showed the same schedule as the old two-player handover minus one redundant pin.

## Caller state

`SampleVoice` is the only live caller. It keeps `enabled`/`timeScale` in its own
`#envelopeConfigs` map (`EnvelopeConfig` now lives in `instruments/Sample/envelope-config.ts`)
and calls `stop()` on voice reuse, disable and dispose. `resolveSampleEnvelopeTrigger`
passes the filter's mapped shape through `options.shape`.

`InstrumentBus` usage stays commented out under `// TODO: @POST_ENV_API_READY` until the
API is final. It is why `DEFAULT_FILTER_ENV_AMOUNT` (`SamplePlayer.ts:54`) warns in lint;
do not "fix" that by deleting it.

## Changesets

`@kidlib/web-audio` is published (0.4.2). Deferred on purpose, reconcile at the end.
Breaking so far: removed `EnvelopeRuntime`, `EnvelopeRuntimeTriggerOptions`,
`assertValidEnvelopeConfig`, `cloneEnvelopeConfig` and `EnvelopePlayer.dispose()`;
`createEnvelope` takes a shape and `trigger` no longer does; presets return `EnvelopeShape`;
the `Envelope` type export is now `EnvelopeShape`.

## Tooling

```
format   npx vp fmt <paths>     oxfmt; singleQuote set in vite.config.ts
test     npx vp test run
lint     npx vp lint
types    npx tsc --noEmit
```

No prettier config; running prettier reformats the repo to double quotes. `tsconfig.json`
excludes tests, so `tsc` does not typecheck them; type-aware lint does, and it failed to
resolve an `@/` import written directly in a test file. A lint-staged pre-commit hook runs
`vp check --fix`.

## Baseline

279 tests pass, 1 skipped; tsc clean; lint has only the warning above.
`TODO.md` tracks deferred items, including an open loop-drift investigation.
