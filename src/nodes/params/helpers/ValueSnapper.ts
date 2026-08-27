import { createScale, offsetPeriodsBySemitones } from "@/utils/music-theory/utils/scale-utils";
import type { NormalizeOptions } from "@/nodes/params/param-types";
import { findClosest, ROOT_NOTES } from "@/utils";

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

// Value processor for snapping/quantization
export class ValueSnapper {
  #allowedValues: number[] = [];
  #allowedPeriods: number[] = [];

  #currentRootNote: keyof typeof ROOT_NOTES = "C";
  #currentScalePattern: number[] = [];

  setScale(
    rootNote: keyof typeof ROOT_NOTES,
    scalePattern: readonly number[] | number[],
    tuningOffset: number = 0, // in semitones
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
      periodsInSeconds = offsetPeriodsBySemitones(
        periodsInSeconds,
        -tuningOffset, // Offset by MINUS the current tuning
      );
    }

    this.#currentRootNote = rootNote;
    this.#currentScalePattern = pattern;

    return this.setAllowedPeriods(periodsInSeconds, normalize, snapToZeroCrossings);
  }

  setRootNote(rootNote: keyof typeof ROOT_NOTES) {
    this.setScale(rootNote, this.#currentScalePattern, 0, 0, 6, false, false);
  }

  // snapToZeroCrossings is accepted but not yet used
  setAllowedPeriods(
    periods: number[],
    normalize: NormalizeOptions | false,
    _snapToZeroCrossings: number[] | false = false,
  ) {
    const values = normalize ? (normalizeRange([...periods], normalize) as number[]) : periods;

    this.#allowedPeriods = [...values].sort((a, b) => a - b);

    return this.#allowedPeriods;
  }

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

  snapToMusicalPeriod(targetPeriod: number, allowedPeriods = this.#allowedPeriods): number {
    if (allowedPeriods.length === 0) return targetPeriod;

    const shortest = allowedPeriods[0];
    const longest = allowedPeriods[allowedPeriods.length - 1];

    if (targetPeriod > longest) return targetPeriod;
    if (targetPeriod <= shortest) return shortest;

    return findClosest(allowedPeriods, targetPeriod);
  }

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
