import { vi } from 'vite-plus/test';
import type { SamplePlayer } from '../SamplePlayer';
import type { SampleVoicePool } from '../SampleVoicePool';
import type { InstrumentBus } from '../../../master/InstrumentBus';

vi.mock('@/nodes/params/LFOs/LFO', () => ({
  LFO: class {
    setWaveform() {}
    getPitchWobbleWaveform() {}
    connect() {}
    dispose() {}
  },
}));

/** Initialize through the real player lifecycle, supplying fake audio components. */
export async function initTestPlayer(player: SamplePlayer, overrides: Partial<SampleVoicePool>) {
  const pool = {
    allVoices: [],
    connect() {},
    onMessage: () => () => {},
    applyToAllVoices() {},
    allNotesOff() {},
    dispose() {},
    ...overrides,
  } as unknown as SampleVoicePool;
  const factory = await import('../createSampleVoicePool');
  const busFactory = await import('../../../master/createInstrumentBus');
  const poolSpy = vi.spyOn(factory, 'createSampleVoicePool').mockResolvedValue(pool);
  const busSpy = vi.spyOn(busFactory, 'createInstrumentBus').mockResolvedValue({
    input: { gain: {} },
    connect() {},
    releaseAll() {},
    dispose() {},
  } as unknown as InstrumentBus);
  try {
    await player.init();
  } finally {
    poolSpy.mockRestore();
    busSpy.mockRestore();
  }
}
