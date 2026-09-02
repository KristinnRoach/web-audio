import { describe, it, expect } from "vite-plus/test";
import { cancelAndPinParamValue } from "./audioparam";

const SR = 48000;
const CANCEL_AT = 0.25; // midpoint of the curve, so the correct hold value is 0.5

/**
 * Guards the cancelAndHoldAtTime workaround in ./audioparam.ts: pins a param
 * mid-curve and checks the gain never jumps back to curve[0].
 *
 * Suspending mid-render is what makes this reproduce - the cancel has to
 * arrive while the audio thread is already inside the curve.
 */
async function renderPinnedMidCurve(apply: (p: AudioParam) => void) {
  const ctx = new OfflineAudioContext(1, SR * 0.5, SR);
  const curve = Float32Array.from({ length: 512 }, (_, i) => 1 - i / 511);

  const dc = new ConstantSourceNode(ctx, { offset: 1 });
  const gain = new GainNode(ctx, { gain: 0 });
  dc.connect(gain).connect(ctx.destination);
  gain.gain.setValueCurveAtTime(curve, 0, 0.5);
  dc.start();

  ctx.suspend(CANCEL_AT).then(() => {
    apply(gain.gain);
    void ctx.resume();
  });

  const data = (await ctx.startRendering()).getChannelData(0);
  return Math.max(...data.subarray(CANCEL_AT * SR)); // curve descends, so any peak > 0.5 is the glitch
}

describe("cancelAndPinParamValue", () => {
  it("holds a partially-rendered setValueCurveAtTime without replaying curve[0]", async () => {
    const pinned = await renderPinnedMidCurve((p) => cancelAndPinParamValue(p, CANCEL_AT));
    expect(pinned).toBeCloseTo(0.5, 2);

    const native = await renderPinnedMidCurve((p) => p.cancelAndHoldAtTime(CANCEL_AT));
    if (native > 0.6) {
      console.log(`cancelAndHoldAtTime still glitches to ${native.toFixed(3)} - workaround needed`);
    } else {
      console.warn(
        `\n*** cancelAndHoldAtTime NO LONGER GLITCHES (peak ${native.toFixed(3)}, expected ~1.0).\n` +
          "*** If Firefox has shipped it too, calls that pass no holdValue can\n" +
          "*** swap to cancelAndHoldAtTime directly. Calls that pass one are\n" +
          "*** pinning a value the automation would not produce on its own, so\n" +
          "*** check each before converting it.\n" +
          "*** See the notes in src/utils/validate/audioparam.ts\n",
      );
    }
  });
});
