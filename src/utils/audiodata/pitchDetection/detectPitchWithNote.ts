import { findClosestNote } from "@/utils";
import type { Note } from "@/utils/music-theory/types";
import { detectSinglePitchAC } from "./autocorrelateSingle";

/**
 * Detects the pitch of a buffer and resolves it against the note table.
 *
 * Note that `periodicity` measures whether the input is pitched at all, not
 * whether the frequency is the note you wanted - see detectSinglePitchAC.
 */
export async function detectPitchWithNote(
  buffer: AudioBuffer,
  logResults = true,
): Promise<{
  frequency: number;
  periodicity: number;
  midiFloat: number;
  targetNoteInfo: Note;
}> {
  const pitchSource = await detectSinglePitchAC(buffer);
  const targetNoteInfo = findClosestNote(pitchSource.frequency);

  const midiFloat = 69 + 12 * Math.log2(pitchSource.frequency / 440);

  if (logResults) {
    console.table({
      frequency: pitchSource.frequency,
      periodicity: pitchSource.periodicity,
      targetNoteInfo,
      playbackRateMultiplier: targetNoteInfo.frequency / pitchSource.frequency,
      midiFloat,
    });
  }

  return {
    frequency: pitchSource.frequency,
    periodicity: pitchSource.periodicity,
    midiFloat,
    targetNoteInfo,
  };
}
