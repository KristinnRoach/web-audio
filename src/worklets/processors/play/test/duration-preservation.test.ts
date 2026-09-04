import { describe, expect, it } from "vite-plus/test";
import { DurationPreserver } from "../duration-preservation.js";

function samplesWithSlopes(slopes: Record<number, "rising" | "falling">) {
  const samples = new Float32Array(32);
  for (const [position, slope] of Object.entries(slopes)) {
    const index = Number(position);
    samples[index - 1] = slope === "rising" ? -1 : 1;
    samples[index + 1] = slope === "rising" ? 1 : -1;
  }
  return samples;
}

describe("DurationPreserver", () => {
  it("selects the nearest reset crossing with the outgoing slope", () => {
    const preserver = new DurationPreserver(100);
    const zeroCrossings = [10, 12, 20];
    const samples = samplesWithSlopes({ 10: "falling", 12: "rising", 20: "rising" });
    preserver.setEnabled(true, 10);

    expect(preserver.prepareCorrection(true, 20, 1, zeroCrossings, samples)).toEqual({
      outgoingPosition: 20,
      resetTarget: 12,
    });
  });

  it("keeps the correction pending when no slope-matched target is available", () => {
    const preserver = new DurationPreserver(100);
    const samples = samplesWithSlopes({ 10: "falling", 12: "rising", 20: "rising" });
    preserver.setEnabled(true, 10);

    expect(preserver.prepareCorrection(true, 20, 1, [10, 20], samples)).toBeNull();
    expect(preserver.prepareCorrection(true, 20, 1, [10, 12, 20], samples)).toEqual({
      outgoingPosition: 20,
      resetTarget: 12,
    });
  });
});
