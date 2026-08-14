export const DEFAULT_COMPRESSOR_SETTINGS = {
  threshold: -13.0,
  knee: 6.0,
  ratio: 4.0,
  attack: 0.003,
  release: 0.05,
} as const;

export const DEFAULT_LIMITER_SETTINGS = {
  threshold: -1, // ? causes ugly clipping ?
  ratio: 20, // Hard limiting
  attack: 0.001, // Very fast attack
  release: 0.01, // Quick release
  knee: 0, // Hard knee
};
