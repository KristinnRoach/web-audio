import { describe, expect, it } from "vite-plus/test";
import {
  addPoint,
  baseDuration,
  deletePoint,
  releaseDuration,
  releaseStartTime,
  scaledDuration,
  setDuration,
  updatePoint,
} from "./envelope-shape";
import type { EnvelopeState, PointEnvelopeShape } from "./env-types";

function shapeOf(overrides: Partial<PointEnvelopeShape> = {}): PointEnvelopeShape {
  return {
    kind: "points",
    points: [
      { time: 0, value: 0, curve: "exponential" },
      { time: 1, value: 1, curve: "exponential" },
      { time: 2, value: 0.5, curve: "exponential" },
      { time: 3, value: 0, curve: "exponential" },
    ],
    valueRange: [0, 1],
    sustainIndex: null,
    releaseIndex: 2,
    ...overrides,
  };
}

const stateOf = (shape: PointEnvelopeShape, overrides: Partial<EnvelopeState> = {}) =>
  ({
    enabled: true,
    timeScale: 1,
    playbackRateSync: false,
    loop: false,
    shape,
    ...overrides,
  }) satisfies EnvelopeState;

describe("envelope-shape edits", () => {
  it("never mutates the shape it was given", () => {
    const shape = shapeOf();
    const before = JSON.stringify(shape);

    addPoint(shape, 1.5, 0.8);
    updatePoint(shape, 1, 1.2);
    deletePoint(shape, 1);
    setDuration(shape, 6);

    expect(JSON.stringify(shape)).toBe(before);
  });

  describe("addPoint", () => {
    it("inserts in time order and carries the markers along", () => {
      const next = addPoint(shapeOf({ sustainIndex: 1 }), 0.5, 0.3);

      expect(next.points.map((point) => point.time)).toEqual([0, 0.5, 1, 2, 3]);
      // Both markers sat after the insert, so they follow their own points.
      expect(next.sustainIndex).toBe(2);
      expect(next.releaseIndex).toBe(3);
    });

    it("leaves markers alone when the point lands after them", () => {
      const next = addPoint(shapeOf({ sustainIndex: 1 }), 2.5, 0.1);
      expect(next.sustainIndex).toBe(1);
      expect(next.releaseIndex).toBe(2);
    });

    it("refuses a point outside the anchors", () => {
      const shape = shapeOf();
      expect(addPoint(shape, -1, 0.5)).toBe(shape);
      expect(addPoint(shape, 4, 0.5)).toBe(shape);
    });
  });

  describe("updatePoint", () => {
    /**
     * The scheduler walks points in order and never re-sorts them, so a crossing edit
     * would silently break the shape rather than fail loudly.
     */
    it("refuses a move across either neighbour", () => {
      const shape = shapeOf();
      expect(updatePoint(shape, 2, 0.5)).toBe(shape); // back past point 1
      expect(updatePoint(shape, 1, 2.5)).toBe(shape); // forward past point 2
      expect(updatePoint(shape, 1, 1.5).points[1].time).toBe(1.5);
    });

    it("changes value without touching time", () => {
      const next = updatePoint(shapeOf(), 1, undefined, 0.25);
      expect(next.points[1]).toMatchObject({ time: 1, value: 0.25 });
    });
  });

  describe("deletePoint", () => {
    it("pulls later markers back", () => {
      const next = deletePoint(shapeOf({ sustainIndex: 1 }), 1);
      expect(next.points.map((point) => point.time)).toEqual([0, 2, 3]);
      expect(next.sustainIndex).toBe(null);
      expect(next.releaseIndex).toBe(1);
    });

    it("keeps a release stage when the release point itself goes", () => {
      const next = deletePoint(shapeOf({ releaseIndex: 2 }), 2);
      expect(next.releaseIndex).toBeLessThan(next.points.length - 1);
      expect(next.releaseIndex).toBeGreaterThanOrEqual(0);
    });

    it("refuses to remove an anchor or to drop below two points", () => {
      const shape = shapeOf();
      expect(deletePoint(shape, 0)).toBe(shape);
      expect(deletePoint(shape, 3)).toBe(shape);

      const pair = shapeOf({ points: shape.points.slice(0, 2), releaseIndex: 0 });
      expect(deletePoint(pair, 1)).toBe(pair);
    });
  });

  describe("setDuration", () => {
    it("scales every point about the first one", () => {
      const next = setDuration(shapeOf(), 6);
      expect(next.points.map((point) => point.time)).toEqual([0, 2, 4, 6]);
      expect(baseDuration(next)).toBe(6);
    });

    it("rejects a duration that is not a positive number", () => {
      expect(() => setDuration(shapeOf(), 0)).toThrow(RangeError);
      expect(() => setDuration(shapeOf(), NaN)).toThrow(RangeError);
    });
  });
});

describe("envelope-shape timing", () => {
  it("divides by timeScale, and by playback rate only when synced", () => {
    const shape = shapeOf();

    expect(scaledDuration(stateOf(shape), 0, 3)).toBe(3);
    expect(scaledDuration(stateOf(shape, { timeScale: 2 }), 0, 3)).toBe(1.5);
    expect(scaledDuration(stateOf(shape, { playbackRateSync: true }), 0, 3, 2)).toBe(1.5);
    expect(scaledDuration(stateOf(shape, { playbackRateSync: false }), 0, 3, 2)).toBe(3);
  });

  it("splits the shape at the release point", () => {
    const state = stateOf(shapeOf());
    expect(releaseStartTime(state)).toBe(2);
    expect(releaseDuration(state)).toBe(1);
    expect(releaseStartTime(state) + releaseDuration(state)).toBe(baseDuration(state.shape));
  });

  it("returns nothing for a backwards or out-of-range span", () => {
    const state = stateOf(shapeOf());
    expect(scaledDuration(state, 2, 1)).toBe(0);
    expect(scaledDuration(state, 0, 99)).toBe(0);
    expect(scaledDuration(state, -1, 2)).toBe(0);
  });
});
