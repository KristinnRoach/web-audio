import { describe, expect, it, vi } from 'vite-plus/test';

// WorkletNode extends AudioWorkletNode, which Node lacks.
class FakeAudioWorkletNode {
  port = { postMessage: vi.fn(), onmessage: null as ((e: unknown) => void) | null };
  parameters = new Map<string, unknown>();
  context = { currentTime: 2 };
}
vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
const { WorkletNode } = await import('./WorkletNode');

function createNode() {
  const node = new WorkletNode({} as AudioContext, 'test-processor');
  const port = node.port as unknown as FakeAudioWorkletNode['port'];
  const receive = (data: unknown) => port.onmessage!({ data });
  return { node, port, receive };
}

describe('WorkletNode', () => {
  it('queues messages until the processor handshake, then flushes in order', () => {
    const { node, port, receive } = createNode();
    const onMessage = vi.fn();
    node.onProcessorMessage(onMessage);

    node.sendProcessorMessage({ type: 'a' }).sendProcessorMessage({ type: 'b' });
    expect(port.postMessage).not.toHaveBeenCalled();

    receive({ type: 'initialized' });
    node.sendProcessorMessage({ type: 'c' });
    expect(port.postMessage.mock.calls.map(([m]) => m.type)).toEqual(['a', 'b', 'c']);

    receive({ type: 'level', value: 1 });
    expect(onMessage.mock.calls.map(([e]) => e.data.type)).toEqual(['initialized', 'level']);
  });

  it('setParam glides by default and sets instantly when timeConstant is 0', () => {
    const { node } = createNode();
    const param = { setTargetAtTime: vi.fn(), setValueAtTime: vi.fn() };
    (node.parameters as unknown as Map<string, unknown>).set('gain', param);

    node.setParam('gain', 0.5).setParam('gain', 1, 0);

    expect(param.setTargetAtTime).toHaveBeenCalledExactlyOnceWith(0.5, 2, 0.005);
    expect(param.setValueAtTime).toHaveBeenCalledExactlyOnceWith(1, 2);
  });
});
