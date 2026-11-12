import { describe, it, expect } from 'vite-plus/test';
import { cancelAndPinParamValue } from '../audioparam-utils';

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

describe('cancelAndPinParamValue', () => {
  it('holds a partially-rendered setValueCurveAtTime without replaying curve[0]', async () => {
    const pinned = await renderPinnedMidCurve((p) => cancelAndPinParamValue(p, CANCEL_AT));
    expect(pinned).toBeCloseTo(0.5, 2);

    const native = await renderPinnedMidCurve((p) => p.cancelAndHoldAtTime(CANCEL_AT));
    if (native > 0.6) {
      console.log(`cancelAndHoldAtTime still glitches to ${native.toFixed(3)} - workaround needed`);
    } else {
      console.warn(
        `\n*** cancelAndHoldAtTime NO LONGER GLITCHES (peak ${native.toFixed(3)}, expected ~1.0).\n` +
          '*** If Firefox has shipped it too, calls that pass no holdValue can\n' +
          '*** swap to cancelAndHoldAtTime directly. Calls that pass one are\n' +
          '*** pinning a value the automation would not produce on its own, so\n' +
          '*** check each before converting it.\n' +
          '*** See the notes in src/nodes/params/audioparam-utils.ts\n',
      );
    }
  });

  // Step left when a glide replacement cuts a fast ramp. Offline suspend reads an exact
  // param.value, so this cannot show a real-time AudioContext's stale read (#33).
  it('measures the step when pinning a fast linear ramp mid-flight', async () => {
    const cancelAt = (94 * 128) / SR; // on a render-quantum boundary, mid-ramp
    const maxJump = async (apply: (p: AudioParam) => void) => {
      const ctx = new OfflineAudioContext(1, SR * 0.5, SR);
      const dc = new ConstantSourceNode(ctx, { offset: 1 });
      const gain = new GainNode(ctx, { gain: 1 });
      dc.connect(gain).connect(ctx.destination);
      gain.gain.setValueAtTime(1, cancelAt - 0.01);
      gain.gain.linearRampToValueAtTime(0, cancelAt + 0.01); // 1 -> 0 over 20 ms
      dc.start();
      ctx.suspend(cancelAt).then(() => {
        apply(gain.gain);
        void ctx.resume();
      });
      const data = (await ctx.startRendering()).getChannelData(0);
      let jump = 0;
      for (let i = cancelAt * SR - 256; i < data.length; i++) {
        jump = Math.max(jump, Math.abs(data[i] - data[i - 1]));
      }
      return jump;
    };

    const pinned = await maxJump((p) => cancelAndPinParamValue(p, cancelAt));
    const native = await maxJump((p) => p.cancelAndHoldAtTime(cancelAt));
    console.log(
      `ramp pin max step: pinned ${pinned.toFixed(4)}, native ${native.toFixed(4)} (ramp slope ${(1 / (0.02 * SR)).toFixed(4)}/sample)`,
    );
    expect(pinned).toBeLessThan(0.01);
    expect(native).toBeLessThan(0.01);
  });
});
