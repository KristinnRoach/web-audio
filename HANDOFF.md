# Handoff: envelope cleanup

Work happens on `envelope-integration-cleanup` ([#114](https://github.com/KristinnRoach/web-audio/pull/114)). Merge [#115](https://github.com/KristinnRoach/web-audio/pull/115) (`filter-env-detune`) into it first.

**Rule:** an envelope never shares a param with a control. It drives a modulation input (`envGain`, worklet `detune`, `lpf.detune`) and the control keeps its own param.

| What                                       | Where                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Status and boundary                        | [#114](https://github.com/KristinnRoach/web-audio/pull/114) description                                                              |
| Generic module: API, backlog               | [envelopes/README.md](src/nodes/params/envelopes/README.md), [envelopes/KNOWN-ISSUES.md](src/nodes/params/envelopes/KNOWN-ISSUES.md) |
| Sampler: param choice, depths, rest values | [sample-envelope-policy.ts](src/nodes/instruments/Sample/sample-envelope-policy.ts)                                                  |
| Sampler: wiring                            | [SampleVoice.ts](src/nodes/instruments/Sample/SampleVoice.ts)                                                                        |
| Next core step, with code                  | [ENVELOPE-TIMELINE-TRACKING.md](ENVELOPE-TIMELINE-TRACKING.md) (`TrackedParam`)                                                      |
