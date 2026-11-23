import { vi } from 'vite-plus/test';
import type { SamplePlayer } from '../SamplePlayer';
import type { InstrumentBus } from '../../../master/InstrumentBus';
import { SAMPLE_PLAYER_WORKLET_AUDIOPARAMS } from '../../../../worklets/processors/play/sample-player-paramdescriptors';

type TestLFO = {
  setMusicalNote: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  setDepth: ReturnType<typeof vi.fn>;
  setFrequency: ReturnType<typeof vi.fn>;
};

const testLFOs = vi.hoisted(() => [] as TestLFO[]);

vi.mock('@/nodes/modulators/LFO/LFO', () => ({
  LFO: class {
    constructor() {
      testLFOs.push(this);
    }
    setWaveform() {}
    storeCurrentValues() {}
    setMusicalNote = vi.fn();
    getPitchWobbleWaveform() {}
    connect = vi.fn();
    setDepth = vi.fn();
    setFrequency = vi.fn();
    dispose() {}
  },
}));

vi.mock('@/nodes/effects/HarmonicFeedback', () => ({
  HarmonicFeedback: class {
    input = { connect() {} };
    output = { connect() {} };
    currentAmount = 0;
    setPitch() {}
    trigger() {}
    setAmountMacro() {}
    dispose() {}
  },
}));

export function getTestLFOs() {
  return testLFOs;
}

const fakeParam = (value: number) => ({
  value,
  setValueAtTime(next: number) {
    this.value = next;
  },
  cancelScheduledValues() {},
  linearRampToValueAtTime() {},
});

class FakeNode {
  gain = fakeParam(1);
  frequency = fakeParam(0);
  detune = fakeParam(0);
  Q = fakeParam(1);
  connect() {}
  disconnect() {}
}

/**
 * Initialize through the real player lifecycle. The processor is a fake worklet:
 * its port records what the player posts and `report()` delivers a processor message.
 */
export async function initTestPlayer(
  player: SamplePlayer,
  { bus = {}, onPost }: { bus?: Partial<InstrumentBus>; onPost?: (message: any) => void } = {},
) {
  const posted: any[] = [];
  let worklet!: { port: { onmessage: (event: { data: unknown }) => void } };
  vi.stubGlobal('GainNode', FakeNode);
  vi.stubGlobal('BiquadFilterNode', FakeNode);
  vi.stubGlobal('AudioNode', FakeNode);
  vi.stubGlobal('AudioParam', class {});
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      parameters = new Map(
        Object.values(SAMPLE_PLAYER_WORKLET_AUDIOPARAMS).map((p) => [
          p.name,
          fakeParam(p.defaultValue),
        ]),
      );
      port = {
        onmessage: null,
        postMessage(message: any) {
          posted.push(message);
          onPost?.(message);
        },
        start() {},
        close() {},
      };
      connect() {}
      constructor() {
        worklet = this as never;
      }
    },
  );
  const busFactory = await import('../../../master/createInstrumentBus');
  const busSpy = vi.spyOn(busFactory, 'createInstrumentBus').mockResolvedValue({
    input: Object.assign(new FakeNode(), { gain: { setValueAtTime: vi.fn() } }),
    connect() {},
    followNote() {},
    setPitchOffset() {},
    dispose() {},
    ...bus,
  } as unknown as InstrumentBus);
  try {
    await player.init();
  } finally {
    busSpy.mockRestore();
  }
  return {
    posted,
    worklet: worklet as unknown as AudioWorkletNode,
    report: (data: object) => worklet.port.onmessage({ data }),
    /** Posted messages of one type. */
    ofType: (type: string) => posted.filter((message) => message.type === type),
  };
}
