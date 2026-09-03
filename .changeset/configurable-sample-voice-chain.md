---
"@kidlib/web-audio": patch
---

- `createSamplePlayer(buffer, polyphony?, context?)` → `createSamplePlayer(buffer, options?)`. Pass `polyphony`, `context`, and the new `voiceSignalChain` through the options object.
- `new SamplePlayer(context, polyphony?, audioBuffer?)` → `new SamplePlayer(options?)`. Pass `context`, `polyphony`, `audioBuffer`, and `voiceSignalChain` through the options object.
- Added the public `SamplePlayerOptions` and `SampleVoiceChainNode` types.
- `voiceSignalChain` allows customizing the which of the four per-voice audio effects are used and in wich order. Accepts an ordered, duplicate-free subset of `"feedback"`, `"am"`, `"hpf"`, and `"lpf"`. An empty array bypasses all optional voice effects; omitted effects ignore their related controls.
