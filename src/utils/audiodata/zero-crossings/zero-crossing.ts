// zero-crossing.ts

const DEFAULT_THRESHOLD = 0.0001;

type ZeroCrossingOptions =
  | { unit: "samples"; threshold?: number }
  | { unit: "seconds"; sampleRate: number; threshold?: number }
  | { unit: "both"; sampleRate: number; threshold?: number };

type ZeroCrossingsByUnit = {
  samples: number[];
  seconds: number[];
};

export function findZeroCrossings(
  channel: Float32Array,
  options: Extract<ZeroCrossingOptions, { unit: "samples" }>,
): number[];
export function findZeroCrossings(
  channel: Float32Array,
  options: Extract<ZeroCrossingOptions, { unit: "seconds" }>,
): number[];
export function findZeroCrossings(
  channel: Float32Array,
  options: Extract<ZeroCrossingOptions, { unit: "both" }>,
): ZeroCrossingsByUnit;
/** Finds the zero crossings in one channel, returned in the requested unit. */
export function findZeroCrossings(
  channel: Float32Array,
  options: ZeroCrossingOptions,
): number[] | ZeroCrossingsByUnit {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const samples: number[] = [];
  const seconds: number[] = [];

  for (let i = 1; i < channel.length; i++) {
    let position: number | undefined;

    if (Math.abs(channel[i]) < threshold) {
      position = i;
    } else if (Math.sign(channel[i]) !== Math.sign(channel[i - 1])) {
      const t = -channel[i - 1] / (channel[i] - channel[i - 1]);
      position = i - 1 + t;
    }

    if (position === undefined) continue;

    if (options.unit !== "seconds") samples.push(Math.round(position));
    if (options.unit !== "samples") seconds.push(position / options.sampleRate);
  }

  if (options.unit === "both") return { samples, seconds };
  return options.unit === "samples" ? samples : seconds;
}
