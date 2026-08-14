const PlaybackRateSemiToneIntervals: Record<string, number> = {
  '0': 1,
  '1': 1.059463094359,
  '2': 1.122462048309,
  '3': 1.189207115,
  '4': 1.2599210498948732,
  '5': 1.3348398541700344,
  '6': 1.4142135623730951,
  '7': 1.4983070768766819,
  '8': 1.5874010519681994,
  '9': 1.681792830507429,
  '10': 1.7817974362806785,
  '11': 1.8877486253633863,
};

export const PlaybackRateSemiToneIntervalsInverse: Record<string, number> = {
  '1': 0,
  '1.059463094359': 1,
  '1.122462048309': 2,
  '1.189207115': 3,
  '1.2599210498948732': 4,
  '1.3348398541700344': 5,
  '1.4142135623730951': 6,
  '1.4983070768766819': 7,
  '1.5874010519681994': 8,
  '1.681792830507429': 9,
  '1.7817974362806785': 10,
  '1.8877486253633863': 11,
};

export const PlaybackRateSemiToneIntervalsKeys = Object.keys(
  PlaybackRateSemiToneIntervals
).map((key) => parseInt(key, 10));

export const getPlaybackRateFromSemiTones = (semitones: number) => {
  const index = semitones % 12;
  const sign = Math.sign(semitones);
  const absIndex = Math.abs(index);
  const octave = Math.floor(semitones / 12);
  const octaveFactor = Math.pow(2, octave);

  return PlaybackRateSemiToneIntervals[absIndex] * sign * octaveFactor;
};

export const getSemiTonesFromPlaybackRate = (playbackRate: number) => {
  const octave = Math.floor(Math.log2(Math.abs(playbackRate)));
  const octaveFactor = Math.pow(2, -octave);
  const adjustedPlaybackRate = playbackRate * octaveFactor;
  const index = Object.keys(PlaybackRateSemiToneIntervals).find(
    (key) => PlaybackRateSemiToneIntervals[key] === adjustedPlaybackRate
  );

  if (index !== undefined) {
    return parseInt(index, 10) + octave * 12;
  }

  return null;
};

export const getPlaybackRateFromPitch = (pitch: number) => {
  const semitones = Math.round(pitch);
  return getPlaybackRateFromSemiTones(semitones);
};

export const getPitchFromPlaybackRate = (playbackRate: number) => {
  const semitones = getSemiTonesFromPlaybackRate(playbackRate);
  if (semitones === null) return null;
  return Math.round(semitones);
};
