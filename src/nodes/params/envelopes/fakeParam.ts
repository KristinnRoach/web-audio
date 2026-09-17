import { vi } from 'vite-plus/test';
import type { AutomatableParam } from './Envelope';

export type ScheduledEvent = {
  type: 'set' | 'linear' | 'exponential' | 'cancel';
  value?: number;
  time: number;
};

export type FakeParam = AutomatableParam & {
  /** Every automation call in the order it arrived. */
  events: ScheduledEvent[];
  /** Automation that moves the parameter, so cancellation is left out. */
  ramps(): ScheduledEvent[];
  /** Value of the last scheduled ramp, or undefined when nothing was scheduled. */
  lastValue(): number | undefined;
};

/**
 * An `AutomatableParam` that records automation instead of producing sound. The one
 * param double the envelope tests use; reach for this rather than a local `vi.fn` mock.
 *
 * Everything lands in one ordered list, which is what per-method spies cannot give you:
 * a loop cycle's opening `setValueAtTime` and the previous cycle's closing ramp go to
 * different spies, and which of them came first is the whole question.
 *
 * Only the four methods the scheduler actually calls are recorded. A scheduler that
 * reached for `setValueCurveAtTime` would record nothing and leave `ramps()` short, so
 * add the method here rather than reading that silence as a pass.
 *
 * `cancelScheduledValues` is how `cancelAndPinParamValue` pins a value, standing in for
 * `cancelAndHoldAtTime`, which Firefox has not shipped. A `cancel` event is that hold.
 */
export function createFakeParam({
  value = 0,
  minValue = 0,
  maxValue = 22050,
}: { value?: number; minValue?: number; maxValue?: number } = {}): FakeParam {
  const events: ScheduledEvent[] = [];
  const record = (type: ScheduledEvent['type']) =>
    vi.fn((...args: number[]) =>
      type === 'cancel'
        ? events.push({ type, time: args[0] })
        : events.push({ type, value: args[0], time: args[1] }),
    );

  const param = {
    value,
    minValue,
    maxValue,
    setValueAtTime: record('set'),
    linearRampToValueAtTime: record('linear'),
    exponentialRampToValueAtTime: record('exponential'),
    cancelScheduledValues: record('cancel'),
    events,
    ramps: () => events.filter((event) => event.type !== 'cancel'),
    lastValue: () => {
      const moves = param.ramps();
      return moves.length ? moves[moves.length - 1].value : undefined;
    },
  };

  return param;
}
