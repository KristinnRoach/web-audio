// DynamicsCompressorNode param limits (Web Audio spec):
// threshold -100..0 dB | knee 0..40 dB | ratio 1..20 | attack 0..1 s | release 0..1 s
// Makeup gain is automatic and NOT adjustable. Not a spec formula: WebKit/Blink
// use (1 / curve(0 dBFS)) ^ 0.6, an empirical exponent, so makeup lands near 0.6x
// the reduction the curve applies at full scale. Lower threshold or higher ratio
// => louder output, not just more control.
// https://github.com/WebAudio/web-audio-api/issues/2639
// https://www.w3.org/TR/webaudio/#DynamicsCompressorNode
// https://developer.mozilla.org/en-US/docs/Web/API/DynamicsCompressorNode

// Headroom at the voice sum: voices arrive peak-normalized near 0 dBFS and add up.
// ~-9 dB keeps a full-velocity 4-note chord under the limiter, which should only
// catch rare peaks. Tune by ear with monitorLevels (`@kidlib/web-audio/debug`).
export const VOICE_SUM_GAIN = 0.35;

// Level trim at full distortion macro, scaled linearly in dB with the amount.
// Measured RMS rise at full macro: ~15 dB in the app (metered), ~19 dB on a
// synthetic decaying chord. The rise is roughly linear in dB, so one number covers
// the range. Clipping makes it depend on input level, so this is a typical-case
// match: raise toward 0 if full distortion sounds too quiet, lower if too loud.
export const DISTORTION_MACRO_TRIM_DB = -15;

export const DEFAULT_COMPRESSOR_SETTINGS = {
  threshold: -16.0, // -24..-12 (lower = more makeup gain, see above)
  knee: 12.0, // 6..30 (soft knee hides the onset; hard knee audibly grabs)
  ratio: 3.0, // 2..4 (above ~6 on a bus it starts pumping)
  attack: 0.01, // 0.005..0.03 s (under ~5 ms the envelope tracks bass cycles -> IMD)
  release: 0.25, // 0.15..0.4 s (under ~0.1 s pumps; over ~0.5 s stops recovering between notes)
} as const;

export const DEFAULT_LIMITER_SETTINGS = {
  threshold: -2, // -3..-1 dB (ratio 20 is not a brick wall: peaks still pass 1/20 of their excess)
  ratio: 20, // 12..20 (20 = spec max, closest to a true limiter)
  attack: 0.002, // 0.001..0.005 s (faster catches peaks but distorts lows)
  release: 0.1, // 0.05..0.25 s (too fast = audible gain ripple on sustained notes)
  knee: 2, // 0..4 dB (small knee softens the grab without letting peaks through)
} as const;
