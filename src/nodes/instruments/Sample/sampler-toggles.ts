import type { SamplePlayer } from './SamplePlayer';

export interface SamplerToggleDescriptor {
  label: string;
  defaultValue: boolean;
  format: (enabled: boolean) => string;
  apply: (player: SamplePlayer, enabled: boolean) => void;
}

export const samplerToggles = {
  timestretch: {
    label: 'Timestretch',
    defaultValue: false,
    format: (enabled) => (enabled ? 'Warp' : 'RePitch'),
    apply: (player, enabled) => player.setTimestretchEnabled(enabled),
  },
  panDrift: {
    label: 'Pan drift',
    defaultValue: true,
    format: (enabled) => (enabled ? '◐' : '○'),
    apply: (player, enabled) => player.setPanDriftEnabled(enabled),
  },
  feedbackMode: {
    label: 'Feedback mode',
    defaultValue: true,
    format: (enabled) => (enabled ? 'Poly' : 'Mono'),
    apply: (player, enabled) =>
      player.setFeedbackMode(enabled ? 'polyphonic' : 'monophonic'),
  },
  gainLFOSync: {
    label: 'Amp LFO sync',
    defaultValue: false,
    format: (enabled) => (enabled ? 'Sync' : 'Free'),
    apply: (player, enabled) => player.syncLFOsToNoteFreq('gain-lfo', enabled),
  },
  pitchLFOSync: {
    label: 'Pitch LFO sync',
    defaultValue: false,
    format: (enabled) => (enabled ? 'Sync' : 'Free'),
    apply: (player, enabled) => player.syncLFOsToNoteFreq('pitch-lfo', enabled),
  },
} as const satisfies Record<string, SamplerToggleDescriptor>;

export type SamplerToggleKey = keyof typeof samplerToggles;
