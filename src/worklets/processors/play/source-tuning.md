# Source tuning: deferred unverified proposal (option B)

Treat the original audio as a virtually resampled source: read original position
`samplerPosition * 2 ** (sourceSemitones / 12)`, while sampler position advances
using only note playback rate and detune. Loop periods stay in corrected-source
coordinates; no snap-specific tuning bypass is needed.

Duration becomes `originalDuration / ratio`. Bounds, zero crossings, position
reporting, smoothing and timestretch must all use compatible coordinates.
Live ratio changes still need a continuity policy (retrigger or crossfade).

References: [current sample reads](./sample-player-processor.js),
[splice timestretch](./splice-stretch.js),
[existing baked resampling (option A)](../../../nodes/preprocessor/Preprocessor.ts).
