import { describe, it, expect } from "vite-plus/test";
import { LFO } from "./LFO";

const SAMPLE_RATE = 48000;
const LFO_HZ = 100;

/** Renders the LFO's own output by using it to modulate a unity DC signal. */
async function renderLFO(configure: (lfo: LFO) => void, durationSeconds = 1) {
  const ctx = new OfflineAudioContext(1, SAMPLE_RATE * durationSeconds, SAMPLE_RATE);

  const lfo = new LFO(ctx as unknown as AudioContext);
  lfo.setWaveform("sine");
  lfo.setFrequency(LFO_HZ);
  lfo.setDepth(1);

  const dc = new ConstantSourceNode(ctx, { offset: 1 });
  const gain = new GainNode(ctx, { gain: 0 });
  dc.connect(gain).connect(ctx.destination);
  lfo.connect(gain.gain);
  dc.start();

  configure(lfo);

  return (await ctx.startRendering()).getChannelData(0);
}

describe("LFO.retrigger", () => {
  // 0.5025s is 50.25 cycles at 100Hz, so a free-running sine sits at its peak
  // there. After a retrigger it must be back at phase 0 instead.
  const AT = 0.5025;
  const atSample = Math.round(AT * SAMPLE_RATE);
  const quarterCycle = Math.round(SAMPLE_RATE / LFO_HZ / 4);

  it("free-running oscillator is mid-cycle at a non-integer cycle boundary", async () => {
    const data = await renderLFO(() => {});
    expect(data[atSample]).toBeCloseTo(1, 1);
  });

  it("restarts at phase 0 at the given timestamp", async () => {
    const data = await renderLFO((lfo) => lfo.retrigger(AT));
    expect(Math.abs(data[atSample])).toBeLessThan(0.02);
    // Rising into the new cycle, at unity: proves the old oscillator stopped
    // rather than summing with the new one.
    expect(data[atSample + quarterCycle]).toBeCloseTo(1, 1);
  });

  it("keeps waveform and frequency across the swap", async () => {
    const data = await renderLFO((lfo) => lfo.retrigger(AT));
    const oneCycle = Math.round(SAMPLE_RATE / LFO_HZ);
    expect(Math.abs(data[atSample + oneCycle])).toBeLessThan(0.02);
  });
});
