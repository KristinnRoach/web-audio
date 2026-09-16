import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { VoiceEnvelope } from "./VoiceEnvelope";
import { createFakeParam, type FakeParam } from "@/nodes/params/envelopes/fakeParam";
import type { EnvelopeSettings } from "@/nodes/params/envelopes";
import { ENVELOPE_TARGETS, type EnvelopeId } from "./envelope-targets";

function contextAt(currentTime: number) {
  return { currentTime, sampleRate: 44100 } as unknown as AudioContext & { currentTime: number };
}

/** Rises to 1 at 0.5s, half back by 1.0s, silent at 1.5s. Release point is 2. */
function settingsOf(overrides: Partial<EnvelopeSettings> = {}): EnvelopeSettings {
  return {
    enabled: true,
    timeScale: 1,
    envelope: {
      points: [
        { time: 0, value: 0, curve: "exponential" },
        { time: 0.5, value: 1, curve: "exponential" },
        { time: 1.0, value: 0.5, curve: "exponential" },
        { time: 1.5, value: 0, curve: "exponential" },
      ],
      release: 2,
    },
    ...overrides,
  };
}

describe("VoiceEnvelope", () => {
  let context: AudioContext & { currentTime: number };
  let param: FakeParam;
  let emitted: Array<{ type: string; data: Record<string, unknown> }>;
  const emit = (type: string, data: Record<string, unknown>) => void emitted.push({ type, data });
  const typesOf = () => emitted.map((message) => message.type);

  beforeEach(() => {
    vi.useFakeTimers();
    context = contextAt(1.0);
    param = createFakeParam({ value: 0.5, minValue: 0, maxValue: 1 });
    emitted = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules from the state it holds, scaled by the trigger's depth", () => {
    const envelope = new VoiceEnvelope(context, "amp-env", settingsOf(), emit);
    envelope.trigger(param, 1.0, { baseValue: 0.25, playbackRate: 1 });

    // Point value 1 at 0.5s, scaled by a velocity of 0.25.
    const peak = Math.max(...param.ramps().map((event) => event.value ?? 0));
    expect(peak).toBeCloseTo(0.25);
    expect(typesOf()).toContain("amp-env:trigger");
  });

  it("releases from where the shape had reached, not from the parameter's value", () => {
    const envelope = new VoiceEnvelope(
      context,
      "amp-env",
      settingsOf({ envelope: { ...settingsOf().envelope, sustain: 1 } }),
      emit,
    );
    envelope.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });
    param.events.length = 0;

    context.currentTime = 3.0;
    envelope.release(3.0);

    expect(param.events.find((event) => event.type === "set")?.value).toBeCloseTo(1);
    expect(typesOf()).toContain("amp-env:release");
  });

  it("releases once, however many times it is asked", () => {
    const envelope = new VoiceEnvelope(context, "amp-env", settingsOf(), emit);
    envelope.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });

    envelope.release(1.0);
    envelope.release(1.0);

    expect(typesOf().filter((type) => type === "amp-env:release")).toHaveLength(1);
  });

  describe("auto-release", () => {
    it("fires once a held note runs past its release point", () => {
      const envelope = new VoiceEnvelope(context, "amp-env", settingsOf(), emit);
      envelope.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });

      expect(typesOf()).not.toContain("amp-env:release");
      vi.advanceTimersByTime(2000);
      expect(typesOf()).toContain("amp-env:release");
    });

    it("never fires while a sustain point holds the note", () => {
      const held = settingsOf({ envelope: { ...settingsOf().envelope, sustain: 1 } });
      new VoiceEnvelope(context, "amp-env", held, emit).trigger(param, 1.0, {
        baseValue: 1,
        playbackRate: 1,
      });

      vi.advanceTimersByTime(5000);
      expect(typesOf()).not.toContain("amp-env:release");
    });

    /** A loop holds the note too, and switching it off has to settle the held deadline. */
    it("is held back by a loop, then settles when the loop is switched off", () => {
      const envelope = new VoiceEnvelope(
        context,
        "amp-env",
        settingsOf({ envelope: { ...settingsOf().envelope, loop: true } }),
        emit,
      );
      envelope.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });

      vi.advanceTimersByTime(2000);
      expect(typesOf()).not.toContain("amp-env:release");

      envelope.applySettings(settingsOf());
      expect(typesOf()).toContain("amp-env:release");
    });

    it("arrives sooner when the envelope is scaled to run faster", () => {
      const fast = new VoiceEnvelope(context, "amp-env", settingsOf({ timeScale: 10 }), emit);
      fast.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });

      vi.advanceTimersByTime(250);
      expect(typesOf()).toContain("amp-env:release");
    });
  });

  describe("state", () => {
    it("leaves a sounding note on the shape it was triggered with", () => {
      const envelope = new VoiceEnvelope(context, "amp-env", settingsOf(), emit);
      envelope.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });
      const scheduled = param.ramps().length;

      envelope.applySettings(settingsOf({ timeScale: 4 }));

      // Nothing is rescheduled underneath a running note; the change lands on the next.
      expect(param.ramps().length).toBe(scheduled);
      expect(envelope.settings.timeScale).toBe(4);
    });

    it("plays the new shape on the next trigger", () => {
      const envelope = new VoiceEnvelope(context, "amp-env", settingsOf(), emit);
      envelope.applySettings(settingsOf({ timeScale: 2 }));

      envelope.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });

      // 1.5s of shape at double speed ends 0.75s after the trigger.
      const last = param.ramps().at(-1);
      expect(last?.time).toBeCloseTo(1.75);
    });
  });

  it("stops without releasing, leaving the state alone for the next note", () => {
    const envelope = new VoiceEnvelope(context, "amp-env", settingsOf(), emit);
    envelope.trigger(param, 1.0, { baseValue: 1, playbackRate: 1 });
    envelope.stop();

    vi.advanceTimersByTime(5000);
    expect(typesOf()).not.toContain("amp-env:release");
    expect(envelope.settings.enabled).toBe(true);
  });

  it("drives the parameter each type is meant to drive", () => {
    const named = (type: EnvelopeId) =>
      new VoiceEnvelope(context, type, ENVELOPE_TARGETS[type].defaults(1), emit).paramName;

    expect(named("amp-env")).toBe("envGain");
    expect(named("pitch-env")).toBe("playbackRate");
    expect(named("filter-env")).toBe("lpf");
  });
});
