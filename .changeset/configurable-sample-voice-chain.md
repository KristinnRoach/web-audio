---
"@kidlib/web-audio": patch
---

Breaking — constructor signatures now take an options object

- createSamplePlayer(buffer, polyphony?, context?) → createSamplePlayer(buffer, options?)
- new SamplePlayer(context, polyphony?, audioBuffer?) → new SamplePlayer(options?)
- Both take { context?, polyphony?, audioBuffer?, voiceSignalChain? }. context now defaults to the global context instead of being required.

New: configurable per-voice signal chain

- voiceSignalChain accepts an ordered, duplicate-free subset of "feedback" | "am" | "hpf" | "lpf". [] bypasses all optional voice effects; omitted effects ignore their related controls. Duplicates throw TypeError.
- New public types: SamplePlayerOptions, SampleVoiceChainNode.

Behaviour changes

- Default voice chain order is now lpf → hpf → am → feedback (was feedback → am → hpf → lpf). Existing patches using filters + AM/feedback will sound different.
- Sample preprocessing: compression is off by default. Pitch detection and auto-HPF now run on a separate internally-compressed buffer, so detection accuracy is unchanged while the output path is no longer compressed.
- Stopping a voice now cancels its in-flight envelope runs; stale envelope callbacks after stop no longer fire or mutate loop state.
- Envelope param cancellation unified on cancelAndPinParamValue — removes the click when re-triggering during a setValueCurveAtTime (Chrome) and the Firefox cancelAndHoldAtTime gap.

New API

- SamplePlayer.availableEnvelopeTypes: EnvelopeType[] — envelope types present on the current voices (empty until the pool initializes; reflects which effects your voiceSignalChain includes). If 'lpf' is omitted from voice chain, filter-env is not available (for now)
