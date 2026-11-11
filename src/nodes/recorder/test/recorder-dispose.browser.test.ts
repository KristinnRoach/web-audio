import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import { Recorder } from '../Recorder';

describe('Recorder', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not arm when disposed while start() is pending', async () => {
    const stop = vi.spyOn(MediaStreamTrack.prototype, 'stop');
    const ctx = new AudioContext();
    const source = new ConstantSourceNode(ctx);
    const recorder = new Recorder(ctx);
    const states: string[] = [];
    recorder.onMessage('state-change', (msg) => states.push(msg.state));

    const pending = recorder.start({ input: { type: 'audio-node', node: source } });
    recorder.dispose();
    await pending;

    expect(recorder.state).toBe('IDLE');
    expect(recorder.initialized).toBe(false);
    expect(states).toEqual([]);
    expect(stop).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('delivers the recorded buffer on record:stop', async () => {
    const ctx = new AudioContext();
    const source = new ConstantSourceNode(ctx);
    source.start();
    const recorder = new Recorder(ctx);
    let delivered: AudioBuffer | undefined;
    recorder.onMessage('record:stop', (msg) => (delivered = msg.buffer));

    await recorder.start({ input: { type: 'audio-node', node: source }, useThreshold: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const buffer = await recorder.stop();

    expect(delivered).toBe(buffer);
    await ctx.close();
  });

  it('records again after stop()', async () => {
    const ctx = new AudioContext();
    const source = new ConstantSourceNode(ctx);
    source.start();
    const recorder = new Recorder(ctx);
    const input = { type: 'audio-node', node: source } as const;

    for (let take = 0; take < 2; take++) {
      await recorder.start({ input, useThreshold: false });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await recorder.stop()).duration).toBeGreaterThan(0);
    }
    await ctx.close();
  });

  it('rejects an out-of-range startThreshold without acquiring input', async () => {
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const ctx = new AudioContext();
    const recorder = new Recorder(ctx);

    await expect(recorder.start({ startThreshold: -80 })).rejects.toThrow(RangeError);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recorder.state).toBe('IDLE');
    await ctx.close();
  });

  it('does not request the microphone when disposed while resuming', async () => {
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const ctx = new AudioContext();
    await ctx.suspend();
    const recorder = new Recorder(ctx);

    const pending = recorder.start();
    recorder.dispose();
    await pending;

    expect(getUserMedia).not.toHaveBeenCalled();
    await ctx.close();
  });
});
