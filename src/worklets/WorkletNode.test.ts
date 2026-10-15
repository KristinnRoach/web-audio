import { describe, expect, it, vi } from 'vite-plus/test';

// WorkletNode extends AudioWorkletNode, which Node lacks.
vi.stubGlobal('AudioWorkletNode', class {});
const { WorkletNode } = await import('./WorkletNode');

function setParamOn(timeConstant?: number) {
  const param = { setTargetAtTime: vi.fn(), setValueAtTime: vi.fn() };
  const node = { parameters: new Map([['gain', param]]), context: { currentTime: 2 } };
  WorkletNode.prototype.setParam.call(node as never, 'gain', 0.5, timeConstant);
  return param;
}

describe('WorkletNode.setParam', () => {
  it('glides with a 5 ms time constant by default', () => {
    const param = setParamOn();
    expect(param.setTargetAtTime).toHaveBeenCalledWith(0.5, 2, 0.005);
    expect(param.setValueAtTime).not.toHaveBeenCalled();
  });

  it('sets the value instantly when timeConstant is 0', () => {
    const param = setParamOn(0);
    expect(param.setValueAtTime).toHaveBeenCalledWith(0.5, 2);
    expect(param.setTargetAtTime).not.toHaveBeenCalled();
  });
});
