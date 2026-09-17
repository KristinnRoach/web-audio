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
 * An `AutomatableParam` that records automation instead of producing sound.
 *
 * Tests assert on what was scheduled rather than on which method was reached, so they
 * survive a change of scheduling strategy. The old mocks each listed only the methods
 * one implementation happened to call, which is why swapping the scheduler broke them
 * before a single behavior had changed.
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
