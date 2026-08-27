import { createScale, offsetPeriodsBySemitones } from "@/utils/music-theory/utils/scale-utils";
import type { NormalizeOptions } from "@/nodes/params/param-types";
import { findClosest, ROOT_NOTES } from "@/utils";

/** Clamps to the `from` range, then maps linearly onto the `to` range. */
const normalizeRange = (
  values: number | number[],
  options: NormalizeOptions,
): number | number[] => {
  const { from, to } = options;
  const [fromMin, fromMax] = from;
  const [toMin, toMax] = to;

  const scale = (toMax - toMin) / (fromMax - fromMin);

  if (Array.isArray(values)) {
    return values.map((v) => {
      const clamped = Math.max(fromMin, Math.min(fromMax, v));
      // linear transformation
      return toMin + (clamped - fromMin) * scale;
    });
  } else {
    const clamped = Math.max(fromMin, Math.min(fromMax, values));
    return toMin + (clamped - fromMin) * scale;
  }
};

/**
 * Quantizes param values against two independent sets: allowed values
 * (`snapToValue`) and allowed periods (`snapToMusicalPeriod`). Both are
 * kept sorted ascending; callers set whichever they need.
 *
 * Periods are in seconds unless a `normalize` option was given, in which
 * case they are stored, and must be queried, in the normalized range.
 */
export class ValueSnapper {
  #allowedValues: number[] = [];
  #allowedPeriods: number[] = [];

  #currentRootNote: keyof typeof ROOT_NOTES = "C";
  #currentScalePattern: number[] = [];

  // Preserved across setRootNote
  #scaleOptions = {
    tuningOffset: 0,
    lowestOctave: 0,
    highestOctave: 6,
    normalize: false as NormalizeOptions | false,
    snapToZeroCrossings: false as number[] | false,
  };

  /**
   * Builds the allowed periods from a scale, one per scale note per octave.
   * @returns the resulting allowed periods, sorted ascending.
   */
  setScale(
    rootNote: keyof typeof ROOT_NOTES,
    scalePattern: readonly number[] | number[],
    /** Shifts every allowed period by this many semitones. Positive is up. */
    tuningOffset: number = 0,
    lowestOctave: number = 0,
    highestOctave: number = 6,
    normalize: NormalizeOptions | false,
    snapToZeroCrossings: number[] | false = false,
  ) {
    // Create a copy of the pattern to ensure it's mutable
    const pattern = [...scalePattern];

    const scale = createScale(rootNote, pattern, lowestOctave, highestOctave);
    let periodsInSeconds = scale.periodsInSec.sort((a, b) => a - b);

    if (tuningOffset !== 0) {
      periodsInSeconds = offsetPeriodsBySemitones(periodsInSeconds, tuningOffset);
    }

    this.#currentRootNote = rootNote;
    this.#currentScalePattern = pattern;
    this.#scaleOptions = {
      tuningOffset,
      lowestOctave,
      highestOctave,
      normalize,
      snapToZeroCrossings,
    };

    return this.setAllowedPeriods(periodsInSeconds, normalize, snapToZeroCrossings);
  }

  /** Rebuilds the allowed periods on a new root, keeping the last `setScale` options. */
  setRootNote(rootNote: keyof typeof ROOT_NOTES) {
    const { tuningOffset, lowestOctave, highestOctave, normalize, snapToZeroCrossings } =
      this.#scaleOptions;

    return this.setScale(
      rootNote,
      this.#currentScalePattern,
      tuningOffset,
      lowestOctave,
      highestOctave,
      normalize,
      snapToZeroCrossings,
    );
  }

  /**
   * Sets the allowed periods, in seconds before `normalize` is applied.
   * `snapToZeroCrossings` is accepted but not yet used.
   */
  setAllowedPeriods(
    periods: number[],
    normalize: NormalizeOptions | false,
    _snapToZeroCrossings: number[] | false = false,
  ) {
    const values = normalize ? (normalizeRange([...periods], normalize) as number[]) : periods;

    this.#allowedPeriods = [...values].sort((a, b) => a - b);

    return this.#allowedPeriods;
  }

  /**
   * Snaps to the closest allowed value. With no `tolerance`, always snaps.
   * With a `tolerance`, snaps only within it, otherwise moves `tolerance`
   * toward the closest value instead of jumping to it.
   * Returns `target` unchanged when no values are set.
   */
  snapToValue(
    target: number,
    allowedValues = this.#allowedValues,
    tolerance?: number,
    preferDirection: "left" | "right" | "any" = "any",
  ): number {
    if (allowedValues.length === 0) return target;

    // No tolerance = simple closest value (for real time quick processing)
    if (tolerance === undefined) {
      return findClosest(allowedValues, target);
    }

    // Filter allowedValues by tolerance
    const validValues = allowedValues.filter((value) => Math.abs(value - target) <= tolerance);

    if (validValues.length > 0) {
      // Normal case: snap to closest within tolerance

      return findClosest(validValues, target, preferDirection);
    }

    // Fallback: move partially toward closest allowed value
    const closest = findClosest(allowedValues, target, preferDirection);
    const directionToClosest = Math.sign(closest - target); // -1 or 1
    return target + directionToClosest * tolerance;
  }

  /**
   * Snaps a period to the closest allowed period. Periods longer than the
   * longest allowed pass through unchanged; shorter ones clamp to the shortest.
   * Snapping to nearest means a target that stays on the same side of the
   * midpoint returns the same period, so no glide is triggered.
   */
  snapToMusicalPeriod(targetPeriod: number, allowedPeriods = this.#allowedPeriods): number {
    if (allowedPeriods.length === 0) return targetPeriod;

    const shortest = allowedPeriods[0];
    const longest = allowedPeriods[allowedPeriods.length - 1];

    if (targetPeriod > longest) return targetPeriod;
    if (targetPeriod <= shortest) return shortest;

    return findClosest(allowedPeriods, targetPeriod);
  }

  /** Sets the allowed values, independent of the allowed periods. */
  setAllowedValues(values: number[], normalize: NormalizeOptions | false) {
    const finalValues = normalize ? normalizeRange(values, normalize) : values;
    this.#allowedValues = [...(finalValues as number[])].sort((a, b) => a - b);

    return this.#allowedValues;
  }

  get rootNote() {
    return this.#currentRootNote;
  }

  get scalePattern() {
    return this.#currentScalePattern;
  }

  get periods() {
    return this.#allowedPeriods;
  }

  get shortestPeriod() {
    return this.#allowedPeriods[0];
  }

  get longestPeriod() {
    const lastIndex = this.#allowedPeriods.length - 1;
    return this.#allowedPeriods[lastIndex];
  }

  get hasValueSnapping(): boolean {
    return this.#allowedValues.length > 0;
  }

  get hasPeriodSnapping(): boolean {
    return this.#allowedPeriods.length > 0;
  }
}
