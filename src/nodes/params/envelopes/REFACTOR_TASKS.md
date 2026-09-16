# Envelope decoupling tasks

- [x] Define the smallest generic runtime that binds envelope settings to an `AudioParam` without instrument IDs, parameter names, or playback-rate vocabulary.
- [x] Move reusable lifecycle timing (trigger, release, loop notifications, automatic completion) into that runtime behind plain callbacks.
- [x] Add generic settings validation and detached-copy helpers so instruments do not reimplement state safety.
- [x] Replace `ENVELOPE_TARGETS` with one sampler-local adapter file containing explicitly named pure functions for defaults, parameter selection, value mapping, and timing inputs.
- [x] Keep `SamplePlayer`, `SampleVoice`, and `InstrumentBus` orchestration outside the generic envelope module.
- [x] Remove the generic module's dependency on sampler envelope IDs and stop exporting a sampler-specific ID as a generic type.
- [ ] Consolidate the per-voice and post-FX filter bindings where this can be done without hiding their different note-lifetime behavior.
- [ ] Update tests around the generic runtime and sampler adapter boundaries.
- [ ] Run formatting, type checks, unit tests, and browser envelope tests.
- [ ] Delete this temporary task list when the refactor is complete.

## Order and guardrails

1. Build and test the generic runtime independently.
2. Extract sampler policy into one adapter file.
3. Migrate `SampleVoice`, then `SamplePlayer`, then `InstrumentBus`.
4. Remove obsolete target and wrapper code only after all consumers have moved.

Prefer a small explicit adapter over configuration machinery. Defer any case that would require the generic runtime to know about voices, instruments, buses, MIDI, keytracking, or named signal-chain nodes.

## Deferred for review

- Browser tests still describe the removed `VoiceEnvelope`/`ENVELOPE_TARGETS` boundary and will be migrated only after the replacement API is approved.
- The post-FX filter still uses its existing `InstrumentBus` scheduler because its shared-note lifetime differs from a per-voice envelope; consolidate only if a simple shared binding emerges.
