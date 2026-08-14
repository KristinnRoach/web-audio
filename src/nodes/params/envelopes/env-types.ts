export type EnvelopeType =
  | 'amp-env'
  | 'pitch-env'
  | 'filter-env'
  | 'loop-env'
  | 'default-env';

export type EnvelopePoint = {
  time: number; // Absolute time in seconds
  value: number; // value to be applied to audioparam
  curve?: 'linear' | 'exponential'; // Curve type to next point
};
