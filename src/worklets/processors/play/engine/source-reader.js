/**
 * Sample access contract: every integer index has a defined value. The reader
 * owns boundary handling; kernels never clamp, wrap or reflect indices.
 * Reads must not allocate. Missing source content is silence.
 * @typedef {{ readTap(index: number): number }} SourceReader
 */

// Repeat the endpoints of [firstIndex, lastIndex], inclusive. Bounds are integer
// sample indices inside the trim: ceil(startSamples) through ceil(endSamples) - 1.
// shortcut: loop edges do not extend the source yet. Short loops can pick up
// content outside the loop, especially with sinc. Add loop-aware readers once
// fractional wrap/reflect continuation is defined; never round loop boundaries.
export class ClampedSourceReader {
  /** @param {Float32Array | null} samples */
  constructor(samples = null, firstIndex = 0, lastIndex = samples ? samples.length - 1 : -1) {
    this.samples = samples;
    this.firstIndex = firstIndex;
    this.lastIndex = lastIndex;
  }

  // The engine reuses this reader across channels, without allocating.
  readTap(index) {
    return this.samples?.[Math.max(this.firstIndex, Math.min(index, this.lastIndex))] || 0;
  }
}
