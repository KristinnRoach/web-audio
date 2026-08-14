// ValueSnapper implementation for processor
export class ValueSnapper {
  constructor() {
    this.allowedValues = [];
    this.allowedPeriods = [];
  }

  setAllowedValues(values) {
    this.allowedValues = [...values].sort((a, b) => a - b);
  }

  setAllowedPeriods(periods) {
    this.allowedPeriods = [...periods].sort((a, b) => a - b);
  }

  snapToValue(target) {
    if (this.allowedValues.length === 0) return target;

    return this.allowedValues.reduce((prev, curr) =>
      Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
    );
  }

  snapToMusicalPeriod(periodToSnap) {
    if (this.allowedPeriods.length === 0) return periodToSnap;

    // Find closest musical period
    const closestPeriod = this.allowedPeriods.reduce((prev, curr) =>
      Math.abs(curr - periodToSnap) < Math.abs(prev - periodToSnap)
        ? curr
        : prev
    );

    return closestPeriod;
  }

  get hasValueSnapping() {
    return this.allowedValues.length > 0;
  }

  get hasPeriodSnapping() {
    return this.allowedPeriods.length > 0;
  }

  get longestPeriod() {
    return this.allowedPeriods[this.allowedPeriods.length - 1] || 0;
  }
}
