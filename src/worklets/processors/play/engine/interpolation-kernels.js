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

// Band-limited read: lowers the cutoff below the output Nyquist frequency for
// rates above 1, so pitching up drops what would fold back instead of aliasing.
/** @param {import('./source-reader.js').SourceReader} source */
export function readSinc(source, position, rate) {
  const scale = Math.min(Math.max(rate, 1), SINC_MAX_RATE);
  const cutoff = SINC_CUTOFF / scale; // kernel zero crossings per source sample
  const halfWidth = SINC_ZERO_CROSSINGS / cutoff;
  const first = Math.ceil(position - halfWidth);
  const last = Math.floor(position + halfWidth);
  let sum = 0;
  let weightSum = 0;
  for (let i = first; i <= last; i++) {
    const tablePosition = Math.abs(position - i) * cutoff * SINC_TABLE_RESOLUTION;
    const tableIndex = Math.floor(tablePosition);
    const a = SINC_TABLE[tableIndex];
    const weight = a + (tablePosition - tableIndex) * (SINC_TABLE[tableIndex + 1] - a);
    sum += weight * source.readTap(i);
    weightSum += weight;
  }
  // Normalizing keeps unity gain at DC wherever the kernel lands between samples.
  return weightSum === 0 ? 0 : sum / weightSum;
}

/** @typedef {'linear' | 'hermite' | 'sinc'} InterpolationMode */

/**
 * @param {InterpolationMode} mode
 * @param {import('./source-reader.js').SourceReader} source
 * @param {number} position Fractional position in source samples.
 * @param {number} rate Nonnegative source samples per output sample.
 */
export function readSource(mode, source, position, rate) {
  if (mode === 'sinc') return readSinc(source, position, rate);
  if (mode === 'linear') return readLinear(source, position);
  return readHermite(source, position);
}
