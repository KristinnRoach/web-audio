# Voice migration plan

Goal: one audio-thread processor per `SamplePlayer` owns voices, allocation and lifecycle. `SampleVoice` and `SampleVoicePool` go away. Part of [the roadmap](SAMPLE_PLAYER_ROADMAP.md), "The processor owns its voices".

## Target

- `SamplePlayer` → one worklet node → `InstrumentBus`.
- Notes, buffer and settings go in on one port. Voice reports come back.
- Per-voice effects are engine stages, shared by all voices, reorderable.

## Steps

Each step is a PR that can be ear-tested. Order: 4a, 5, 4b, then 6 and 7.

- [x] 1. Pure allocator in the engine ([#184](https://github.com/KristinnRoach/web-audio/pull/184)).
- [x] 2. Allocate on the audio thread; main thread mirrors ([#185](https://github.com/KristinnRoach/web-audio/pull/185)).
- [x] 3. One processor, one output per voice. Effects stay on the main thread, wired to the outputs.
- [x] 4a. Fold `SampleVoicePool` into `SamplePlayer`; stateless settings posted once, untagged ([#PR](PR_URL)). Contract: [SAMPLE_PLAYER_PROCESSOR.md](SAMPLE_PLAYER_PROCESSOR.md).
- [ ] 5. Pitch settings on the audio thread; it computes every note's rate.
- [ ] 4b. Voice state mirror into plain records on `SamplePlayer`; `SampleVoice` keeps only its effect chain and is renamed `VoiceEffects`.
- [ ] 6. Port per-voice effects into the engine, one PR each: filters, AM, feedback.
- [ ] 7. Mix voices in the processor; single stereo output. Delete `SampleVoice`.

## Removed along the way

- Step 3 (done): shared `pools` map, buffer barrier, per-attempt pool id, one buffer copy per voice.
- Step 4a (done): `SampleVoicePool`, the same setting posted once per voice, a second `pool:allNotesOff` on each load.
- Step 4b: the one-voice processor a lone `SampleVoice` makes.
- Step 5: fallback rate round trip (`pitchId`, `noteId`), shared-pitch shortcut in `noteOn`.
- Step 6: effects trailing the note by a message.
- Any step after 3: exact steal timing (engine holds a pending note).

## Open

- Per-voice metering (`getGainStages`) needs a source after step 7.
