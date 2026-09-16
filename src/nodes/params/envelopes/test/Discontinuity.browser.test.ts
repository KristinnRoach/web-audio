import { describe, it, expect, vi } from "vite-plus/test";
import { CustomEnvelope } from "../CustomEnvelope";
import { EnvelopeData } from "../EnvelopeData";
import { createFakeParam } from "./fakeParam";

vi.mock("../../../nodes/node-store", () => ({
  createNodeId: vi.fn(() => "test-node-id"),
  deleteNodeId: vi.fn(),
  registerNode: vi.fn(() => "test-node-id"),
  unregisterNode: vi.fn(),
}));

vi.mock("@/events", () => ({
  createMessageBus: vi.fn(() => ({
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
  })),
}));

const context = { currentTime: 0, sampleRate: 44100 } as unknown as AudioContext;

/**
 * What a trigger does to a parameter that is already moving.
 *
 * These replace a pair of tests written against the old value-curve generator, which
 * overwrote the first sample of every curve with the parameter's current value. That
 * gave roughly one sample of ramp out of the old value, so the shape effectively began
 * with a 1-2 ms glide. The scheduler steps to the first point instead.
 *
 * The step is the contract now, so it is what gets pinned down here. Whether the
 * missing glide is audible when retriggering a voice mid-flight is an ear question,
 * not a test question.
 */
describe("CustomEnvelope trigger handoff", () => {
  function envelopeOf(type: "amp-env" | "filter-env") {
    return new CustomEnvelope(
      context,
      type,
      new EnvelopeData(
        [
          { time: 0, value: 0, curve: "exponential" },
          { time: 0.1, value: 1, curve: "exponential" },
          { time: 1, value: 0, curve: "exponential" },
        ],
        [0, 1],
        1,
      ),
    );
  }

  it("starts from the envelope's own first value, whatever the parameter was doing", () => {
    const param = createFakeParam({ value: 0.73, minValue: 0, maxValue: 1 });
    envelopeOf("amp-env").triggerEnvelope(param, 0, { baseValue: 1, playbackRate: 1 });

    // Exponential segments cannot start at zero, so the first point is floored rather
    // than written as 0. It must still be far below the parameter's stale 0.73.
    const first = param.ramps()[0];
    expect(first.time).toBe(0);
    expect(first.value).toBeLessThan(0.01);
  });

  it("clears prior automation exactly once, at the trigger time", () => {
    const param = createFakeParam({ value: 0.73, minValue: 0, maxValue: 1 });
    envelopeOf("amp-env").triggerEnvelope(param, 0, { baseValue: 1, playbackRate: 1 });

    const cancels = param.events.filter((event) => event.type === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].time).toBe(0);
  });

  it("keeps a filter sweep monotonic in Hz with no jump back through the base", () => {
    const param = createFakeParam({ value: 5000, minValue: 20, maxValue: 20000 });
    envelopeOf("filter-env").triggerEnvelope(param, 0, { baseValue: 1000, playbackRate: 1 });

    const values = param.ramps().map((event) => event.value ?? 0);
    // 0 rests on the cutoff, 1 reaches the ceiling, and every step stays inside them.
    expect(values[0]).toBeCloseTo(1000, 0);
    expect(Math.max(...values)).toBeLessThanOrEqual(param.maxValue);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(param.minValue);
    expect(values.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
  });
});
