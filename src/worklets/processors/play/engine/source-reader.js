/**
 * Sample access contract: every integer index has a defined value. The reader
 * owns boundary handling; kernels never clamp, wrap or reflect indices.
 * Reads must not allocate. Missing source content is silence.
 * @typedef {{ readTap(index: number): number }} SourceReader
 */

// Before the first sample, reflect through it (odd reflection), so a fade running past
// the start keeps its slope instead of flattening. After the last, repeat it.
// shortcut: loop edges do not extend the source yet. Short loops can pick up
// content outside the loop, especially with sinc. Add loop-aware readers once
// fractional wrap/reflect continuation is defined; never round loop boundaries.
export class ClampedSourceReader {
  /** @param {Float32Array | null} samples */
  constructor(samples = null) {
    this.samples = samples;
  }

  // The voice reuses this reader across channels, without allocating.
  readTap(index) {
    const samples = this.samples;
    if (!samples?.length) return 0;
    const last = samples.length - 1;
    if (index >= 0) return samples[Math.min(index, last)] || 0;
    return 2 * samples[0] - (samples[Math.min(-index, last)] || 0);
  }
}
