import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { midiToPlaybackRate } from '../../../../utils/music-theory/utils/core-utils';
import {
  makeParameters,
  setupProcessorGlobals,
  startProcessor,
  TEST_SAMPLE_RATE,
} from './range-test-helpers';

const ROOT_MIDI_NOTE = 60;
const LOOP_LENGTH_SAMPLES = 192;
const FIRST_MIDI_NOTE = 36;
const LAST_MIDI_NOTE = 96;
const REVERSE_TEST_MIDI_NOTE = 88;
const WRAPS_TO_MEASURE = 32;
const TUNING_TOLERANCE_CENTS = 3;

async function measureLoopPeriod(
  midiNote: number,
  playbackDirection: 'forward' | 'reverse' = 'forward',
  loopLengthSamples = LOOP_LENGTH_SAMPLES,
  driftAmount = 0,
): Promise<number> {
  const processor = await startProcessor();
  Object.assign(processor.engine, { enableLoopCrossfade: false });
  if (playbackDirection === 'reverse') {
    processor.port.onmessage?.({
      data: { type: 'voice:setPlaybackDirection', playbackDirection },
    } as MessageEvent);
  }
  const playbackRate = midiToPlaybackRate(midiNote, ROOT_MIDI_NOTE);
  const parameters = makeParameters({
    playbackRate,
    loopEnd: loopLengthSamples / TEST_SAMPLE_RATE,
    loopDurationDriftAmount: driftAmount,
  });
  const direction = playbackDirection === 'forward' ? 1 : -1;
  // Allow for the reverse approach through the buffer and drift-expanded passes.
  const maxFrames = Math.ceil(
    (TEST_SAMPLE_RATE + 2 * loopLengthSamples * WRAPS_TO_MEASURE) / playbackRate,
  );
  const output = [new Float32Array(1)];
  const wrapFrames: number[] = [];
  let previousPosition = processor.engine.playheadPosition;
  for (let frame = 0; frame < maxFrames && wrapFrames.length < WRAPS_TO_MEASURE; frame++) {
    processor.process([], [output], parameters);
    const position = processor.engine.playheadPosition;
    if (frame > 0 && (position - previousPosition) * direction < 0) wrapFrames.push(frame);
    previousPosition = position;
  }

  expect(wrapFrames).toHaveLength(WRAPS_TO_MEASURE);
  return (wrapFrames[wrapFrames.length - 1] - wrapFrames[0]) / (wrapFrames.length - 1);
}

describe('audio-rate loop tuning', () => {
  setupProcessorGlobals();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['forward', 'reverse'] as const)(
    'does not shift a minimum-length %s loop for sub-half-sample drift',
    async (direction) => {
      // Captured 30% UI drift maps to this worklet amount. At 92 samples,
      // adaptive scaling limits drift to about +/-0.0146 source samples.
      for (const randomValue of [0.25, 0.75]) {
        vi.spyOn(Math, 'random').mockReturnValue(randomValue);
        const period = await measureLoopPeriod(84, direction, 92, 0.0015848932089284062);
        expect(period).toBe(23);
      }
    },
  );

  it.each([
    { loopLength: 92, driftAmount: 0.2, delta: 1 },
    { loopLength: 9600, driftAmount: 0.001, delta: 5 },
  ])('retains symmetric audible drift for $loopLength-sample loops', async (testCase) => {
    for (const sign of [-1, 1]) {
      vi.spyOn(Math, 'random').mockReturnValue(sign < 0 ? 0.25 : 0.75);
      const period = await measureLoopPeriod(
        ROOT_MIDI_NOTE,
        'forward',
        testCase.loopLength,
        testCase.driftAmount,
      );
      expect(period).toBe(testCase.loopLength + sign * testCase.delta);
    }
  });

  it('stays in tune while stepping chromatically from C2 through C7', async () => {
    const results = [];

    for (let midiNote = FIRST_MIDI_NOTE; midiNote <= LAST_MIDI_NOTE; midiNote++) {
      const playbackRate = midiToPlaybackRate(midiNote, ROOT_MIDI_NOTE);
      const expectedPeriod = LOOP_LENGTH_SAMPLES / playbackRate;
      const measuredPeriod = await measureLoopPeriod(midiNote);
      const centsError = 1_200 * Math.log2(expectedPeriod / measuredPeriod);

      results.push({ midiNote, expectedPeriod, measuredPeriod, centsError });
    }

    const outOfTuneNotes = results
      .filter(({ centsError }) => Math.abs(centsError) > TUNING_TOLERANCE_CENTS)
      .map(({ midiNote, centsError }) => ({
        midiNote,
        centsError: Number(centsError.toFixed(2)),
      }));

    expect(outOfTuneNotes, 'notes outside the 3-cent tuning tolerance').toEqual([]);
  });

  it('stays in tune during reverse playback at MIDI 88', async () => {
    const playbackRate = midiToPlaybackRate(REVERSE_TEST_MIDI_NOTE, ROOT_MIDI_NOTE);
    const expectedPeriod = LOOP_LENGTH_SAMPLES / playbackRate;
    const measuredPeriod = await measureLoopPeriod(REVERSE_TEST_MIDI_NOTE, 'reverse');
    const centsError = 1_200 * Math.log2(expectedPeriod / measuredPeriod);

    expect(
      Math.abs(centsError),
      `reverse tuning error: ${centsError.toFixed(2)} cents`,
    ).toBeLessThanOrEqual(TUNING_TOLERANCE_CENTS);
  });
});
