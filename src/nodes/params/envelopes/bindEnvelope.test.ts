import { describe, expect, it } from "vite-plus/test";
import { bindEnvelope } from "./bindEnvelope";
import { interpolateAtTime } from "./Envelope";
import type { EnvelopeState } from "./env-types";

function stateOf(overrides: Partial<EnvelopeState> = {}): EnvelopeState {
  return {
    enabled: true,
    timeScale: 1,
    playbackRateSync: false,
    loop: false,
    shape: {
      kind: "points",
      points: [
        { time: 0, value: 0, curve: "exponential" },
        { time: 0.5, value: 1, curve: "exponential" },
        { time: 1, value: 0, curve: "exponential" },
      ],
      valueRange: [0, 1],
      sustainIndex: null,
      releaseIndex: 1,
    },
    ...overrides,
  };
}

describe("bindEnvelope", () => {
  describe("filter-env", () => {
    const base = 200;
    const ceiling = 20000;

    it("maps point values geometrically from the cutoff to the ceiling", () => {
      const { envelope, options } = bindEnvelope(stateOf(), "filter-env", {
        baseValue: base,
        playbackRate: 1,
        ceiling,
      });

      // 0 rests on the cutoff, 1 reaches the ceiling, 0.5 lands on the geometric mean
      // rather than the arithmetic one (2000 Hz, not 10100).
      expect(envelope.points[0].value).toBeCloseTo(base);
      expect(envelope.points[1].value).toBeCloseTo(ceiling);
      expect(options).toEqual({ base: 0, amount: 1, timeScale: 1 });

      const half = bindEnvelope(
        stateOf({
          shape: {
            ...stateOf().shape,
            points: [
              { time: 0, value: 0.5 },
              { time: 1, value: 1 },
            ],
          },
        }),
        "filter-env",
        { baseValue: base, playbackRate: 1, ceiling },
      );
      expect(half.envelope.points[0].value).toBeCloseTo(Math.sqrt(base * ceiling));
    });

    /**
     * The claim the swap rests on: mapping each point and riding an exponential ramp
     * between them is the same curve the old generator drew sample by sample, where it
     * interpolated in normalized space and mapped every sample into Hz.
     */
    it("matches a per-sample map through log-Hz", () => {
      const { envelope } = bindEnvelope(stateOf(), "filter-env", {
        baseValue: base,
        playbackRate: 1,
        ceiling,
      });

      const logLow = Math.log(base);
      const logRange = Math.log(ceiling) - logLow;
      const oldGenerator = (t: number) =>
        Math.exp(logLow + logRange * interpolateAtTime(stateOf().shape.points, t));

      for (const t of [0, 0.1, 0.25, 0.4, 0.5]) {
        expect(interpolateAtTime(envelope.points, t)).toBeCloseTo(oldGenerator(t), 4);
      }
    });

    it("keeps the sweep off zero when the cutoff is not a usable frequency", () => {
      const { envelope } = bindEnvelope(stateOf(), "filter-env", {
        baseValue: 0,
        playbackRate: 1,
        ceiling,
      });

      expect(envelope.points.every((point) => point.value > 0)).toBe(true);
      expect(Number.isFinite(envelope.points[0].value)).toBe(true);
    });
  });

  describe("multiplicative types", () => {
    it("carries the depth in amount and leaves point values normalized", () => {
      const { envelope, options } = bindEnvelope(stateOf(), "amp-env", {
        baseValue: 0.5,
        playbackRate: 1,
      });

      expect(options.amount).toBe(0.5);
      expect(options.base).toBe(0);
      expect(envelope.points.map((point) => point.value)).toEqual([0, 1, 0]);
    });
  });

  describe("timeScale", () => {
    it("folds the playback rate in only when the state asks for it", () => {
      const synced = stateOf({ timeScale: 2, playbackRateSync: true });
      const loose = stateOf({ timeScale: 2, playbackRateSync: false });

      expect(
        bindEnvelope(synced, "amp-env", { baseValue: 1, playbackRate: 3 }).options.timeScale,
      ).toBe(6);
      expect(
        bindEnvelope(loose, "amp-env", { baseValue: 1, playbackRate: 3 }).options.timeScale,
      ).toBe(2);
    });

    it("falls back to 1 rather than collapsing every point onto one instant", () => {
      for (const timeScale of [0, -1, NaN, Infinity]) {
        const { options } = bindEnvelope(stateOf({ timeScale }), "amp-env", {
          baseValue: 1,
          playbackRate: 1,
        });
        expect(options.timeScale).toBe(1);
      }
    });
  });

  describe("shape", () => {
    it("ends the loop on the sustain point when there is one", () => {
      const { envelope } = bindEnvelope(
        stateOf({ loop: true, shape: { ...stateOf().shape, sustainIndex: 1 } }),
        "amp-env",
        { baseValue: 1, playbackRate: 1 },
      );
      expect(envelope.sustain).toBe(1);
      expect(envelope.loop).toBe(true);
    });

    /**
     * A loop with no sustain point repeats the whole shape. The scheduler can only
     * express a loop as "up to the sustain point", so the last point stands in as the
     * loop end. Without this, turning loop on for a shape that has no sustain - the
     * default amp envelope, for one - would silently stop looping.
     */
    it("loops the whole shape when there is no sustain point", () => {
      const { envelope } = bindEnvelope(stateOf({ loop: true }), "amp-env", {
        baseValue: 1,
        playbackRate: 1,
      });
      expect(envelope.sustain).toBe(envelope.points.length - 1);
      expect(envelope.loop).toBe(true);
      expect(envelope.release).toBe(1);
    });

    it("holds nothing when there is neither a sustain point nor a loop", () => {
      const { envelope } = bindEnvelope(stateOf(), "amp-env", { baseValue: 1, playbackRate: 1 });
      expect(envelope.sustain).toBeUndefined();
      expect(envelope.loop).toBeUndefined();
      expect(envelope.release).toBe(1);
    });
  });
});
