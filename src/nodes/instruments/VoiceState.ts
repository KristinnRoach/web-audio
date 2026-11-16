/**
 * A voice is only ever one of three things: free to take, sounding, or fading
 * out. Readiness is deliberately not a state: a voice can be reloaded while
 * sounding. AVAILABLE means "not sounding", not "playable".
 *
 * `SamplePlayer` sets it from its processor's reports.
 */
export const VoiceState = {
  AVAILABLE: 'AVAILABLE',
  PLAYING: 'PLAYING',
  RELEASING: 'RELEASING',
} as const;

export type VoiceState = (typeof VoiceState)[keyof typeof VoiceState];
