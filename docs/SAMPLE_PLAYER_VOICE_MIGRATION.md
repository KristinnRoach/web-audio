# Voice migration plan

Goal: one audio-thread processor per `SamplePlayer` owns voices, allocation and lifecycle. `SampleVoice` and `SampleVoicePool` go away. Part of [the roadmap](SAMPLE_PLAYER_ROADMAP.md), "The processor owns its voices".

## Target

- `SamplePlayer` → one worklet node → `InstrumentBus`.
- Notes, buffer and settings go in on one port. Voice reports come back.
- Per-voice effects are engine stages, shared by all voices, reorderable.

## Steps

Each step is a PR that can be ear-tested.

- [x] 1. Pure allocator in the engine ([#184](https://github.com/KristinnRoach/web-audio/pull/184)).
- [x] 2. Allocate on the audio thread; main thread mirrors ([#185](https://github.com/KristinnRoach/web-audio/pull/185)).
- [ ] 3. One processor, one output per voice. Effects stay on the main thread, wired to the outputs.
- [ ] 4. Fold `SampleVoicePool` into `SamplePlayer`. `SampleVoice` keeps only its effect chain.
- [ ] 5. Pitch settings on the audio thread; it computes every note's rate.
- [ ] 6. Port per-voice effects into the engine, one PR each: filters, AM, feedback.
- [ ] 7. Mix voices in the processor; single stereo output. Delete `SampleVoice`.

## Removed along the way

- Step 3: shared `pools` map, buffer barrier (`bufferId`), per-attempt pool id, one buffer copy per voice.
- Step 5: fallback rate round trip (`pitchId`, `noteId`), shared-pitch shortcut in `noteOn`.
- Step 6: effects trailing the note by a message.
- Any step after 3: exact steal timing (engine holds a pending note).

## Open

- Per-voice `AudioParam`s become one shared set at step 3. Check nothing modulates a single voice.
- Per-voice metering (`getGainStages`) needs a source after step 7.
