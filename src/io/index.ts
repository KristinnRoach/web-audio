// Only what a consumer uses; add exports back as they're needed e2e.
export { inputController, getMidiSupportInfo } from './midi/input-controller';
export type { NoteTarget, NoteEvent, ControlChangeEvent } from './midi/input-controller';
