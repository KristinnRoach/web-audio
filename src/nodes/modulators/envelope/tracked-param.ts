import type { AutomatableParam } from './envelope-scheduling';

type ScheduledEvent = { type: 'set' | 'linear' | 'exponential'; value: number; time: number };

/**
 * Forwards automation to a param and keeps a copy of what was scheduled, so `valueAt`
 * reads the timeline the param actually plays: floors, curve substitutions and glides
 * included, because they all arrive here as ordinary automation calls.
 *
 * Values follow the Web Audio spec's automation formulas:
 * https://www.w3.org/TR/webaudio/#computation-of-value
 * Same approach as Tone.js `Param`, which mirrors every event in a timeline:
 * https://github.com/Tonejs/Tone.js/blob/main/Tone/core/context/Param.ts
 *
 * ponytail: only sees writes made through this wrapper, and has no `setTargetAtTime`.
 * Anything written to the param directly is invisible to `valueAt` until the next write
 * here cancels past it; `Envelope` only reads while its own run owns the param.
 */
export class TrackedParam implements AutomatableParam {
  #events: ScheduledEvent[] = [];

  constructor(
    readonly param: AutomatableParam,
    readonly clock: { readonly currentTime: number },
  ) {}

  get value() {
    return this.param.value;
  }

  set value(value: number) {
    this.param.value = value;
    this.#record({ type: 'set', value, time: this.clock.currentTime });
  }

  setValueAtTime(value: number, time: number) {
    this.param.setValueAtTime(value, time);
    this.#record({ type: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.param.linearRampToValueAtTime(value, time);
    this.#record({ type: 'linear', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.param.exponentialRampToValueAtTime(value, time);
    this.#record({ type: 'exponential', value, time });
    return this;
  }

  cancelScheduledValues(time: number) {
    this.param.cancelScheduledValues(time);
    this.#events = this.#events.filter((event) => event.time < time);
    return this;
  }

  /**
   * The value the param has at `time`, from the automation scheduled through this wrapper.
   * Meant for `time >= clock.currentTime`; events already played are pruned.
   */
  valueAt(time: number): number {
    const nextIndex = this.#events.findIndex((event) => event.time > time);
    const previous = this.#events[(nextIndex === -1 ? this.#events.length : nextIndex) - 1];
    // Nothing scheduled at or before `time`: only the live value is known.
    if (!previous) return this.param.value;

    const next = this.#events[nextIndex];
    if (!next || next.type === 'set') return previous.value;

    const progress = (time - previous.time) / (next.time - previous.time);
    if (next.type === 'linear') return previous.value + (next.value - previous.value) * progress;
    // The spec holds an exponential ramp at its start value when an end is zero or the signs differ.
    if (previous.value * next.value <= 0) return previous.value;
    return previous.value * (next.value / previous.value) ** progress;
  }

  /**
   * Cancels everything from `time` on and pins the value the timeline has there.
   * Returns that value.
   *
   * A ramp still running at `time` is shortened to end there rather than dropped, so a
   * future-dated hold keeps the param moving until then instead of freezing it now.
   * A ramp of the same type ending at a point on its own curve traces the same curve.
   *
   * ponytail: pins rather than calling `cancelAndHoldAtTime`, which Firefox has not
   * implemented (bugzil.la/1308431).
   */
  holdAt(time: number): number {
    const value = this.valueAt(time);
    // The segment playing into `time` ends at the first event at or after it.
    const segmentEnd = this.#events.find((event) => event.time >= time);

    this.cancelScheduledValues(time);
    if (segmentEnd && segmentEnd.type !== 'set') {
      // An event exactly at `time` is restored as it was; a later one is cut to `value`.
      const end = segmentEnd.time === time ? segmentEnd.value : value;
      if (segmentEnd.type === 'linear') this.linearRampToValueAtTime(end, time);
      // An exponential ramp cannot target zero; that segment was holding at its start anyway.
      else if (end !== 0) this.exponentialRampToValueAtTime(end, time);
    }
    this.setValueAtTime(value, time);

    return value;
  }

  #record(event: ScheduledEvent) {
    // The spec places an event after any already at the same time.
    const index = this.#events.findIndex((other) => other.time > event.time);
    if (index === -1) this.#events.push(event);
    else this.#events.splice(index, 0, event);

    // Drop events the param has played past; the latest of them still starts the next ramp.
    const now = this.clock.currentTime;
    while (this.#events.length > 1 && this.#events[1].time <= now) this.#events.shift();
  }
}
