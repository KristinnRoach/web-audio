// DynamicsCompressorNode param limits (Web Audio spec):
// threshold -100..0 dB | knee 0..40 dB | ratio 1..20 | attack 0..1 s | release 0..1 s
// Makeup gain is automatic and NOT adjustable: roughly |threshold| * (1 - 1/ratio) dB.
// Lower threshold or higher ratio => louder output, not just more control.
// https://github.com/WebAudio/web-audio-api/issues/2639
// https://www.w3.org/TR/webaudio/#DynamicsCompressorNode
// https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode

export const DEFAULT_COMPRESSOR_SETTINGS = {
  threshold: -16.0, // -24..-12 (lower = more makeup gain, ~10.7 dB here)
  knee: 12.0, // 6..30 (soft knee hides the onset; hard knee audibly grabs)
  ratio: 3.0, // 2..4 (above ~6 on a bus it starts pumping)
  attack: 0.01, // 0.005..0.03 s (under ~5 ms the envelope tracks bass cycles -> IMD)
  release: 0.25, // 0.15..0.4 s (under ~0.1 s pumps; over ~0.5 s stops recovering between notes)
} as const;

export const DEFAULT_LIMITER_SETTINGS = {
  threshold: -2, // -3..-1 dB (no lookahead, so leave room for overshoot)
  ratio: 20, // 12..20 (20 = spec max, closest to a true limiter)
  attack: 0.002, // 0.001..0.005 s (faster catches peaks but distorts lows)
  release: 0.1, // 0.05..0.25 s (too fast = audible gain ripple on sustained notes)
  knee: 2, // 0..4 dB (small knee softens the grab without letting peaks through)
} as const;
