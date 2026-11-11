// Reconstruction math only: source.readTap(index) supplies every integer tap,
// including taps beyond the source boundaries. No transport or loop state.

// Windowed-sinc kernel: half-width in zero crossings at rate <= 1, and the
// passband edge as a fraction of the (possibly lowered) Nyquist frequency.
const SINC_ZERO_CROSSINGS = 8;
const SINC_CUTOFF = 0.9;
// The kernel widens with the rate, so its cost does too. Above this rate it stops
// widening and aliasing returns gradually. Tune against the timing baseline.
const SINC_MAX_RATE = 8;
const SINC_TABLE_RESOLUTION = 512; // table points per zero crossing

// Blackman-windowed sinc from 0 to SINC_ZERO_CROSSINGS, built once at load.
const SINC_TABLE = new Float32Array(SINC_ZERO_CROSSINGS * SINC_TABLE_RESOLUTION + 2);
for (let i = 0; i < SINC_TABLE.length; i++) {
  const u = i / SINC_TABLE_RESOLUTION;
  const w = Math.min(1, u / SINC_ZERO_CROSSINGS); // 0 at the centre, 1 at the edge
  const window = 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w);
  SINC_TABLE[i] = u === 0 ? 1 : (window * Math.sin(Math.PI * u)) / (Math.PI * u);
}

/** @param {import('./source-reader.js').SourceReader} source */
export function readLinear(source, position) {
  const index = Math.floor(position);
  const a = source.readTap(index);
  const b = source.readTap(index + 1);
  return a + (position - index) * (b - a);
}

// 4-point, 3rd-order Hermite (Catmull-Rom).
/** @param {import('./source-reader.js').SourceReader} source */
export function readHermite(source, position) {
  const index = Math.floor(position);
  const t = position - index;
  const xm1 = source.readTap(index - 1);
  const x0 = source.readTap(index);
  const x1 = source.readTap(index + 1);
  const x2 = source.readTap(index + 2);
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

// Each head caches only its weights, never source samples or output. The first
// channel computes weights while reading; later channels reuse them.
export class SincKernel {
  constructor() {
    // Float64 preserves the original JS weight precision. Size for the rate cap.
    this.weights = new Float64Array(
      Math.floor((2 * SINC_ZERO_CROSSINGS * SINC_MAX_RATE) / SINC_CUTOFF) + 1,
    );
    this.position = NaN;
    this.rate = NaN;
    this.firstIndex = 0;
    this.tapCount = 0;
    this.weightSum = 0;
  }

  /** @param {import('./source-reader.js').SourceReader} source */
  read(source, position, rate) {
    const weights = this.weights;
    if (position === this.position && rate === this.rate) {
      const { firstIndex, tapCount, weightSum } = this;
      let sum = 0;
      for (let tap = 0; tap < tapCount; tap++) {
        sum += weights[tap] * source.readTap(firstIndex + tap);
      }
      return weightSum === 0 ? 0 : sum / weightSum;
    }

    // Lower the cutoff when pitching up. No allocation or separate weight pass.
    const scale = Math.min(Math.max(rate, 1), SINC_MAX_RATE);
    const cutoff = SINC_CUTOFF / scale;
    const halfWidth = SINC_ZERO_CROSSINGS / cutoff;
    const firstIndex = Math.ceil(position - halfWidth);
    const tapCount = Math.floor(position + halfWidth) - firstIndex + 1;
    let sum = 0;
    let weightSum = 0;
    for (let tap = 0; tap < tapCount; tap++) {
      const index = firstIndex + tap;
      const tablePosition = Math.abs(position - index) * cutoff * SINC_TABLE_RESOLUTION;
      const tableIndex = Math.floor(tablePosition);
      const a = SINC_TABLE[tableIndex];
      const weight = a + (tablePosition - tableIndex) * (SINC_TABLE[tableIndex + 1] - a);
      weights[tap] = weight;
      sum += weight * source.readTap(index);
      weightSum += weight;
    }
    this.position = position;
    this.rate = rate;
    this.firstIndex = firstIndex;
    this.tapCount = tapCount;
    this.weightSum = weightSum;
    // Normalizing keeps unity gain at DC wherever the kernel lands between samples.
    return weightSum === 0 ? 0 : sum / weightSum;
  }
}

/** @typedef {'linear' | 'hermite' | 'sinc'} InterpolationMode */

/**
 * @param {InterpolationMode} mode
 * @param {import('./source-reader.js').SourceReader} source
 * @param {number} position Fractional position in source samples.
 * @param {number} rate Nonnegative source samples per output sample.
 * @param {SincKernel} sincKernel The head’s reusable weight cache.
 */
export function readSource(mode, source, position, rate, sincKernel) {
  if (mode === 'sinc') return sincKernel.read(source, position, rate);
  if (mode === 'linear') return readLinear(source, position);
  return readHermite(source, position);
}
