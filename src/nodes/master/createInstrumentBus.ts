import { InstrumentBus } from './InstrumentBus';

export async function createInstrumentBus(context: BaseAudioContext): Promise<InstrumentBus> {
  const bus = new InstrumentBus(context);
  await bus.init();
  return bus;
}

export type { InstrumentBus };
