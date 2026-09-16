/**
 * A voice is only ever one of three things: free to take, sounding, or fading
 * out. Readiness is deliberately not a state: it has its own lifetime (a voice
 * can be reloaded while sounding) and folding it in would need a fourth state
 * for the idle-but-unloaded voice. `SampleVoice.#hasLoadedAudio` tracks it and
 * gates `trigger()`, so AVAILABLE means "not sounding", not "playable".
 *
 * Past construction, `SampleVoice.#transitionTo` is the only state writer.
 */
export const VoiceState = {
  AVAILABLE: "AVAILABLE",
  PLAYING: "PLAYING",
  RELEASING: "RELEASING",
} as const;

export type VoiceState = (typeof VoiceState)[keyof typeof VoiceState];
