/**
 * Sample access contract: every integer index has a defined value. The reader
 * owns boundary handling; kernels never clamp, wrap or reflect indices.
 * Reads must not allocate. Missing source content is silence.
 * @typedef {{ readTap(index: number): number }} SourceReader
 */

// Bounds are integer sample indices inside the trim, inclusive: ceil(startSamples)
// through ceil(endSamples) - 1. Before firstIndex, reflect through the first sample
// (odd reflection), so a fade running past the start keeps its slope instead of
// flattening. After lastIndex, repeat the last sample; the tail fade covers that end.
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
    const samples = this.samples;
    if (!samples) return 0;
    const first = this.firstIndex;
    const last = this.lastIndex;
    if (index >= first) return samples[Math.min(index, last)] || 0;
    const edge = samples[first] || 0;
    return 2 * edge - (samples[Math.max(first, Math.min(2 * first - index, last))] || 0);
  }
}
