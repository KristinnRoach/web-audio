import { describe, expect, it } from "vite-plus/test";
import { EnvelopeData } from "./EnvelopeData";

describe("EnvelopeData.setDurationSeconds", () => {
  it("proportionally resizes point times without changing their values", () => {
    const data = new EnvelopeData(
      [
        { time: 0, value: 0 },
        { time: 0.5, value: 1 },
        { time: 2, value: 0 },
      ],
      [0, 1],
      2,
    );

    data.setDurationSeconds(4);

    expect(data.points).toEqual([
      { time: 0, value: 0 },
      { time: 1, value: 1 },
      { time: 4, value: 0 },
    ]);
    expect(data.durationSeconds).toBe(4);
  });
});
