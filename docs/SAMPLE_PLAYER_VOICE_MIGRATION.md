# Voice migration plan

Goal: one audio-thread processor per `SamplePlayer` owns voices, allocation and lifecycle. `SampleVoice` (now `VoiceEffects`) and `SampleVoicePool` go away. Part of [the roadmap](SAMPLE_PLAYER_ROADMAP.md), "The processor owns its voices".

## Target

- `SamplePlayer` → one worklet node → `InstrumentBus`.
- Notes, buffer and settings go in on one port. Voice reports come back.
- Per-voice effects are engine stages, shared by all voices, reorderable.

## Steps

Steps 1–5 (including 4a and 4b) are merged. Each remaining step is one or more PRs that can be ear-tested.

- [x] 1. Pure allocator in the engine ([#184](https://github.com/KristinnRoach/web-audio/pull/184)).
- [x] 2. Allocate on the audio thread; main thread mirrors ([#185](https://github.com/KristinnRoach/web-audio/pull/185)).
- [x] 3. One processor, one output per voice. Effects stay on the main thread, wired to the outputs.
- [x] 4a. Fold `SampleVoicePool` into `SamplePlayer`; stateless settings posted once, untagged ([#188](https://github.com/KristinnRoach/web-audio/pull/188)). Contract: [SAMPLE_PLAYER_PROCESSOR.md](SAMPLE_PLAYER_PROCESSOR.md).
- [x] 5. Pitch settings on the audio thread; it computes every note's rate ([#189](https://github.com/KristinnRoach/web-audio/pull/189)).
- [x] 4b. Voice state mirror into plain records on `SamplePlayer`; `SampleVoice` keeps only its effect chain and is renamed `VoiceEffects` ([#190](https://github.com/KristinnRoach/web-audio/pull/190)).
- [ ] 6. Port per-voice effects (`VoiceEffects`) into the engine, one PR each: filters, AM, feedback.
- [ ] 7. Mix voices in the processor; single stereo output. Delete `VoiceEffects`.

## Removed along the way

- Step 3 (done): shared `pools` map, buffer barrier, per-attempt pool id, one buffer copy per voice.
- Step 4a (done): `SampleVoicePool`, the same setting posted once per voice, a second `pool:allNotesOff` on each load.
- Step 4b (done): the one-voice processor a lone `SampleVoice` made, its standalone note path (`trigger`, `release`, `stop`, `voice:release`) and its message bus.
- Step 5 (done): fallback rate round trip (`pitchId`, `noteId`), shared-pitch shortcut in `noteOn`.
- Step 6: AM and feedback following note reports on the main thread.

## Open

- Exact steal timing needs a pending note while the outgoing note fades ([#170](https://github.com/KristinnRoach/web-audio/issues/170)).
- Per-voice metering (`getGainStages`) needs a source after step 7.
- Scheduled offline note delivery remains unresolved ([#187](https://github.com/KristinnRoach/web-audio/issues/187)); moving effects alone does not establish startup readiness.
