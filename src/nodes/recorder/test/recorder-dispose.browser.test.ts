import { describe, it, expect } from 'vite-plus/test';
import { Recorder } from '../Recorder';

describe('Recorder', () => {
  it('does not arm when disposed while start() is pending', async () => {
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
    await ctx.close();
  });
});
