import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { CustomEnvelope } from "../CustomEnvelope";
import { EnvelopeData } from "../EnvelopeData";
import { createFakeParam, type FakeParam } from "./fakeParam";

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

/**
 * These assert on what the envelope schedules, not on which AudioParam method it
 * reaches for. The release stage is the tail after the release point, starting wherever
 * the shape had got to when the note was let go.
 */
function contextAt(currentTime: number) {
  const context = {
    currentTime,
    sampleRate: 44100,
    getOutputTimestamp: () => ({ contextTime: currentTime, performanceTime: 0 }),
  };
  return context as unknown as AudioContext & { currentTime: number };
}

/** Rises to 1 at 0.5s, half back down by 1.0s, silent at 1.5s. Release point is 2. */
function shape(sustainIndex?: number) {
  return new EnvelopeData(
    [
      { time: 0, value: 0, curve: "exponential" },
      { time: 0.5, value: 1, curve: "exponential" },
      { time: 1.0, value: 0.5, curve: "exponential" },
      { time: 1.5, value: 0, curve: "exponential" },
    ],
    [0, 1],
    1.5,
    sustainIndex,
    2,
  );
}

describe("CustomEnvelope release", () => {
  let context: AudioContext & { currentTime: number };
  let param: FakeParam;

  beforeEach(() => {
    vi.useFakeTimers();
    context = contextAt(1.0);
    param = createFakeParam({ value: 0.5, minValue: 0, maxValue: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("pins the parameter at the release time and schedules the tail", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape());

    envelope.triggerEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });
    param.events.length = 0;

    envelope.releaseEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });

    // The tail is the one point after the release point, so it lands on silence.
    expect(param.events[0]).toMatchObject({ type: "cancel", time: 1.0 });
    expect(param.events.filter((event) => event.type === "cancel")).toHaveLength(1);
    expect(param.lastValue()).toBeCloseTo(0);
  });

  it("releases from where the shape had reached, not from the parameter's value", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape(1));

    envelope.triggerEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });
    param.events.length = 0;

    // Held well past the sustain point at 0.5s, so the shape is holding at 1.
    context.currentTime = 3.0;
    envelope.releaseEnvelope(param, 3.0);

    const pinned = param.events.find((event) => event.type === "set");
    expect(pinned?.value).toBeCloseTo(1);
    expect(pinned?.time).toBe(3.0);
  });

  it("hands release off from the current loop phase", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape());
    envelope.setLoopEnabled(true);

    envelope.triggerEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });
    param.events.length = 0;

    // 2.25s after the trigger, so 0.75s into the third pass of a 1.5s loop. The shape
    // is on its way down from 1 at 0.5s to 0.5 at 1.0s.
    context.currentTime = 3.25;
    envelope.releaseEnvelope(param, 3.25);

    const pinned = param.events.find((event) => event.type === "set");
    expect(pinned?.time).toBe(3.25);
    expect(pinned?.value).toBeGreaterThan(0.5);
    expect(pinned?.value).toBeLessThan(1);
  });

  it("scales the release by velocity, because depth rides in the envelope's amount", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape(1));

    envelope.triggerEnvelope(param, 1.0, { baseValue: 0.25, playbackRate: 1 });
    param.events.length = 0;

    context.currentTime = 3.0;
    envelope.releaseEnvelope(param, 3.0);

    // Holding at point value 1, scaled by a velocity of 0.25.
    expect(param.events.find((event) => event.type === "set")?.value).toBeCloseTo(0.25);
  });

  it("uses the current time when the release is dated in the past", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape());
    envelope.triggerEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });
    param.events.length = 0;

    context.currentTime = 2.0;
    envelope.releaseEnvelope(param, 1.0);

    expect(param.events.every((event) => event.time >= 2.0)).toBe(true);
  });

  it("releases only once", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape());
    envelope.triggerEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });

    envelope.releaseEnvelope(param, 1.0);
    const afterFirst = param.events.length;
    envelope.releaseEnvelope(param, 1.0);

    expect(param.events.length).toBe(afterFirst);
  });

  it("stays finite when a large timeScale collapses the release to nothing", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape());
    envelope.setTimeScale(10000);

    envelope.triggerEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });
    param.events.length = 0;
    envelope.releaseEnvelope(param, 1.0);

    expect(param.events.length).toBeGreaterThan(0);
    expect(param.events.every((event) => Number.isFinite(event.time))).toBe(true);
    expect(param.ramps().every((event) => Number.isFinite(event.value ?? 0))).toBe(true);
  });

  it("sends the release message with the release point and remaining duration", () => {
    const envelope = new CustomEnvelope(context, "amp-env", shape());
    const sent = vi.spyOn(envelope, "sendUpstreamMessage");

    envelope.triggerEnvelope(param, 1.0, { baseValue: 1, playbackRate: 1 });
    envelope.releaseEnvelope(param, 1.0, {
      baseValue: 1,
      playbackRate: 1,
      voiceId: "test-voice",
      midiNote: 64,
    });

    expect(sent).toHaveBeenCalledWith("amp-env:release", {
      voiceId: "test-voice",
      midiNote: 64,
      releasePoint: {
        time: expect.any(Number),
        value: expect.any(Number),
        curve: expect.any(String),
      },
      remainingDuration: expect.any(Number),
    });
  });
});

describe("CustomEnvelope auto-release when loop is turned off mid-note", () => {
  let context: AudioContext & { currentTime: number };
  let param: FakeParam;

  beforeEach(() => {
    vi.useFakeTimers();
    context = contextAt(1.0);
    param = createFakeParam({ value: 0.5, minValue: 0, maxValue: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("suppresses auto-release while looping, then releases once the loop is switched off", () => {
    // No sustain point: without a loop holding it, this envelope auto-releases.
    const envelope = new CustomEnvelope(context, "amp-env", shape());
    const sent = vi.spyOn(envelope, "sendUpstreamMessage");

    envelope.setLoopEnabled(true);
    envelope.triggerEnvelope(param, 1.0, {
      baseValue: 1,
      playbackRate: 1,
      voiceId: "test-voice",
      midiNote: 64,
    });

    // Past the release deadline; the loop is still holding the note.
    vi.advanceTimersByTime(2000);
    expect(sent).not.toHaveBeenCalledWith("amp-env:release", expect.anything());

    envelope.setLoopEnabled(false);

    expect(sent).toHaveBeenCalledWith(
      "amp-env:release",
      expect.objectContaining({ voiceId: "test-voice", midiNote: 64 }),
    );
  });
});
