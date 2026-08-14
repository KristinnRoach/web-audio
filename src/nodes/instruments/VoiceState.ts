export const VoiceState = {
  NOT_READY: 'NOT_READY',
  LOADED: 'LOADED',
  PLAYING: 'PLAYING',
  RELEASING: 'RELEASING',
  STOPPING: 'STOPPING', // REMOVE if redundant
  STOPPED: 'STOPPED',
} as const;

export type VoiceState = (typeof VoiceState)[keyof typeof VoiceState];
