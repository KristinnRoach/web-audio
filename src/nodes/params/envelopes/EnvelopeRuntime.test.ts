import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFakeParam } from "./fakeParam";
import { EnvelopeRuntime } from "./EnvelopeRuntime";
import type { EnvelopeSettings } from "./Envelope";

function contextAt(currentTime: number) {
  return { currentTime, sampleRate: 44100 } as AudioContext & { currentTime: number };
}

function settingsOf(overrides: Partial<EnvelopeSettings> = {}): EnvelopeSettings {
  return {
    enabled: true,
    timeScale: 1,
    envelope: {
      points: [
        { time: 0, value: 0 },
        { time: 0.5, value: 1 },
        { time: 1, value: 0.5 },
        { time: 1.5, value: 0 },
      ],
      release: 2,
    },
    ...overrides,
  };
}

describe("EnvelopeRuntime callbacks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not create callback timers when it has no callbacks", () => {
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf());
    runtime.trigger(createFakeParam(), 0);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports scheduled points and completion", () => {
    const onPoint = vi.fn();
    const onComplete = vi.fn();
    const runtime = new EnvelopeRuntime(contextAt(0), settingsOf(), { onPoint, onComplete });

    runtime.trigger(createFakeParam(), 0, { timeScaleMultiplier: 2 });
    vi.advanceTimersByTime(750);

    expect(onPoint.mock.calls.map(([details]) => details.index)).toEqual([0, 1, 2, 3]);
    expect(onPoint.mock.calls.map(([details]) => details.time)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("keeps callbacks on the active shape after settings change", () => {
    const context = contextAt(0);
    const onPoint = vi.fn();
    const onComplete = vi.fn();
    const runtime = new EnvelopeRuntime(context, settingsOf(), { onPoint, onComplete });

    runtime.trigger(createFakeParam(), 0);
    runtime.applySettings(
      settingsOf({
        timeScale: 10,
        envelope: {
          points: [
            { time: 0, value: 0 },
            { time: 1, value: 1 },
            { time: 2, value: 0 },
          ],
          release: 1,
        },
      }),
    );

    context.currentTime = 0.25;
    runtime.release(0.25);
    vi.advanceTimersByTime(500);

    const releasePoint = onPoint.mock.calls.find(([details]) => details.index === 3)?.[0];
    expect(releasePoint?.point.value).toBe(0);
    expect(releasePoint?.time).toBe(0.75);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("requires a release point", () => {
    const settings = settingsOf() as unknown as {
      enabled: boolean;
      timeScale: number;
      envelope: { points: EnvelopeSettings["envelope"]["points"] };
    };
    delete (settings.envelope as { release?: number }).release;

    expect(() => new EnvelopeRuntime(contextAt(0), settings as EnvelopeSettings)).toThrow(
      "Invalid envelope settings",
    );
  });
});
