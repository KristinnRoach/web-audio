# Sample player safety net and cleanup

Roadmap steps 1 and 2 were implemented on 2026-11-04. The annotated tag
`sample-player-before-cleanup` preserves multiple-buffer loading and tempo sync,
with the new safety tests already in place.

## Render reference

`render-output.test.ts` pins 8,192 stereo frames through `process()` for a moving
quantized loop (including a length change and glide), ping-pong turns, and period
stretch at rate 2. Full left-channel output is rounded to 1e-6 and fingerprinted;
the right channel is checked against its source relationship on every frame.
Existing focused tests retain their edge, click, wrap and stretch assertions.
The reference fingerprints were captured before cleanup and pass unchanged after it.

## Timing

Run `vp run test:sample-timing`. This opt-in Node test renders 16 active stereo
voices at 48 kHz in 128-frame blocks. Each scenario warms up for 100 blocks,
then measures 500 blocks, reporting median, p95, maximum and over-budget count.
The corresponding audio block budget is 2.667 ms. The source and output arrays
are reused; voice restart, clock updates and assertions are outside the timed
region. Moving-loop automation preparation is included. Message delivery is a
no-op, so this measures processor work rather than browser messaging overhead.

Observed on macOS arm64, Node 26.13.0 (milliseconds per block of all 16 voices):

| Scenario              | Before p50 | Before p95 | Before max | Before over budget | After p50 | After p95 | After max | After over budget |
| --------------------- | ---------: | ---------: | ---------: | -----------------: | --------: | --------: | --------: | ----------------: |
| Moving quantized loop |      0.869 |      2.571 |     50.052 |             23/500 |     0.645 |     0.891 |     3.324 |             1/500 |
| Ping-pong             |      0.262 |      0.703 |      1.982 |              0/500 |     0.179 |     0.307 |     2.020 |             0/500 |
| Stretch               |      0.287 |      0.918 |      2.029 |              0/500 |     0.138 |     0.204 |     0.340 |             0/500 |

These are individual local runs with uncontrolled system load, useful as an
initial reference, not proof of a speedup or browser real-time safety. There is
no machine-dependent timing assertion in CI. Re-run on the same machine under
similar load when comparing future changes.

## API migration

- `SamplePlayerOptions.audio` and `loadAudio()` accept one `AudioInput`.
  `loadAudio()` resolves to `AudioBuffer | null`, rather than an array.
- Read `player.audiobuffer` instead of `player.samples[0]`; `samples` and
  `MAX_SAMPLES` were removed. Layer separate players/voices for multiple sources.
- `SampleVoice.loadBuffer()` and `SampleVoicePool.setBuffer()` replace
  `loadAudioData()` and `setAudioData()`. The worklet takes `voice:setBuffer`
  with an array of channels for one source; stereo remains supported.
- `setTempo()`, `syncLoopToTempo()`, the `tempo` getter, sampler parameter and
  worklet AudioParam, and their update messages were removed. Repository-wide
  inspection found no tempo consumers outside the sampler. Keytracking remains.

Single-source rendering, preprocessing, sample-rate conversion, recorder loading,
crop and pitch commit remain supported. Loading failures retain the previous
sample and release the loading lock for retry; validated silent crops remain valid.
