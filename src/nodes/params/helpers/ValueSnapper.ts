import {
  createScale,
  offsetPeriodsBySemitones,
} from '@/utils/music-theory/utils/scale-utils';
import type { NormalizeOptions } from '@/nodes/params/param-types';
import { findClosest, findClosestNote, Note, ROOT_NOTES } from '@/utils';

const normalizeRange = (
  values: number | number[],
  options: NormalizeOptions
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
  #prevIndex = 0;

  #currentRootNote: keyof typeof ROOT_NOTES = 'C';
  #currentScalePattern: number[] = [];

  paramType: string | null = null;

  setScale(
    rootNote: keyof typeof ROOT_NOTES,
    scalePattern: readonly number[] | number[],
    tuningOffset: number = 0, // in semitones
    lowestOctave: number = 0,
    highestOctave: number = 6,
    normalize: NormalizeOptions | false,
    snapToZeroCrossings: number[] | false = false
  ) {
    // Create a copy of the pattern to ensure it's mutable
    const pattern = [...scalePattern];

    const scale = createScale(rootNote, pattern, lowestOctave, highestOctave);
    let periodsInSeconds = scale.periodsInSec.sort((a, b) => a - b);

    if (tuningOffset !== 0) {
      periodsInSeconds = offsetPeriodsBySemitones(
        periodsInSeconds,
        -tuningOffset // Offset by MINUS the current tuning
      );
    }

    this.#currentRootNote = rootNote;
    this.#currentScalePattern = pattern;

    return this.setAllowedPeriods(
      periodsInSeconds,
      normalize,
      snapToZeroCrossings
    );
  }

  setRootNote(rootNote: keyof typeof ROOT_NOTES) {
    this.setScale(rootNote, this.#currentScalePattern, 0, 0, 6, false, false);
  }

  setAllowedPeriods(
    periods: number[],
    normalize: NormalizeOptions | false,
    snapToZeroCrossings: number[] | false = false,
    direction: 'left' | 'right' | 'any' = 'any'
  ) {
    let values = normalize
      ? (normalizeRange([...periods], normalize) as number[])
      : periods;

    // Keep original periods for musical calculations
    // let values = [...periods];

    // if (snapToZeroCrossings && snapToZeroCrossings.length) {
    //   // Pre-compute the optimal values and store them as the allowedPeriods

    //   console.log('Zero Crossings: ', snapToZeroCrossings);
    //   console.log('Before snapping: ', periods);

    //   values = values.map((v) => {
    //     const tolerance = v < 0.01 ? v * 0.01 : v * 0.1; // 1% for periods < 10ms (~16 cents max), 10% for longer
    //     const snapped = this.snapToValue(
    //       v,
    //       snapToZeroCrossings,
    //       tolerance,
    //       direction
    //     );

    //     const correctionFactor = 0.99; // For some reason ALMOST always better results
    //     return snapped * correctionFactor;
    //   });

    //   console.log('After snapping: ', values);
    // }

    // // NOW normalize the snapped periods for 0-1 range
    // const normalized = normalize
    //   ? (normalizeRange(values, normalize) as number[])
    //   : values;

    // console.log('Normalized: ', normalized);

    // this.#debugPeriods(periods, values, normalized);

    this.#allowedPeriods = [...(values as number[])].sort((a, b) => a - b);

    this.#prevIndex = this.#allowedPeriods.length - 1;

    return this.#allowedPeriods;
  }

  #debugPeriods(
    beforeSnap: number[],
    afterSnap: number[],
    normalized: number[]
  ) {
    const beforeNoteInfo: Note[] = [];
    beforeSnap.forEach((period) => {
      beforeNoteInfo.push(findClosestNote(1 / period));
    });
    const afterNoteInfo: Note[] = [];
    afterSnap.forEach((period) => {
      afterNoteInfo.push(findClosestNote(1 / period));
    });

    console.info({ BEFORE: beforeNoteInfo, AFTER: afterNoteInfo, normalized });
  }

  snapToValue(
    target: number,
    allowedValues = this.#allowedValues,
    tolerance?: number,
    preferDirection: 'left' | 'right' | 'any' = 'any'
  ): number {
    if (allowedValues.length === 0) return target;

    // No tolerance = simple closest value (for real time quick processing)
    if (tolerance === undefined) {
      return findClosest(allowedValues, target);
    }

    // Filter allowedValues by tolerance
    const validValues = allowedValues.filter(
      (value) => Math.abs(value - target) <= tolerance
    );

    if (validValues.length > 0) {
      // Normal case: snap to closest within tolerance

      return findClosest(validValues, target, preferDirection);
    }

    // Fallback: move partially toward closest zero crossing
    if (tolerance !== undefined) {
      const closest = findClosest(allowedValues, target, preferDirection);
      const directionToClosest = Math.sign(closest - target); // -1 or 1
      return target + directionToClosest * tolerance;
    }

    return target;
  }

  snapToMusicalPeriod(
    targetPeriod: number,
    allowedPeriods = this.#allowedPeriods
  ): number {
    if (allowedPeriods.length === 0) return targetPeriod;
    if (targetPeriod > this.longestPeriod) return targetPeriod;
    if (targetPeriod <= this.shortestPeriod) return this.shortestPeriod;

    // Find closest musical period to the target duration

    const prevPeriod = this.#allowedPeriods[this.#prevIndex];

    if (targetPeriod === prevPeriod) return targetPeriod;

    const direction = targetPeriod > prevPeriod ? 'right' : 'left';
    // console.debug('PERIOD', direction);

    // TODO: Test current direction based approach VS 'findClosest'
    const quantized = findClosest(allowedPeriods, targetPeriod, direction);

    this.#prevIndex = this.#allowedPeriods.indexOf(quantized);

    // let quantized = targetPeriod;
    // let idx = this.#prevIndex;
    // if (direction === 'right') {
    //   if (targetPeriod < this.#allowedPeriods[idx + 1]) return prevPeriod;

    //   while (this.#allowedPeriods[idx] < targetPeriod) idx++;
    //   quantized = this.#allowedPeriods[idx];
    // }
    // if (direction === 'left') {
    //   if (targetPeriod > this.#allowedPeriods[idx - 1]) return prevPeriod;

    //   while (this.#allowedPeriods[idx] > targetPeriod) idx--;
    //   quantized = this.#allowedPeriods[idx];
    // }

    // this.#prevIndex = idx;

    return quantized;
  }

  setAllowedValues(values: number[], normalize: NormalizeOptions | false) {
    const finalValues = normalize ? normalizeRange(values, normalize) : values;
    this.#allowedValues = [...(finalValues as number[])].sort((a, b) => a - b);

    // console.log('Allowed Values: ', values);
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

// const C = {
//   0: 0.06116,
//   3: 0.007645,
//   4: 0.003822,
//   5: 0.001911,
//   6: 0.000956,
//   7: 0.000478,
//   8: 0.000239,
// };

// // let directionToUse: 'left' | 'right' | 'any' = 'any';
// // let preferredDirection: 'left' | 'right' | 'any' = 'any';
// // if (this.paramType === 'loopEnd') preferredDirection = 'left';
// // if (this.paramType === 'loopStart') preferredDirection = 'right';

// values = values.map((v) => {
//   // let tolerance = 0;
//   // if (v <= C[0]) tolerance = v * 0.1;
//   // if (v <= C[3]) tolerance = v * 0.001;
//   // if (v <= C[4]) tolerance = v * 0.0007;
//   // if (v <= C[5]) tolerance = v * 0.0005;
//   // if (v <= C[6]) tolerance = v * 0.0002;
//   // if (v <= C[7]) tolerance = v * 0.0001;
//   // if (v <= C[8]) tolerance = v * 0.00005;
