import { describe, it, expect } from 'vitest';
import { noteNameToFreq, noteNamesToPeriod } from '../index';

describe('notes constants', () => {
  it('should have matching keys in noteNameToFreq and noteNamesToPeriod', () => {
    expect(Object.keys(noteNameToFreq)).toEqual(Object.keys(noteNamesToPeriod));
  });

  it('should correctly calculate periods from frequencies', () => {
    // Test a few key notes
    expect(noteNamesToPeriod.A4).toBeCloseTo(1 / 440.0); // A4 (concert pitch)
    expect(noteNamesToPeriod.C4).toBeCloseTo(1 / 261.63); // Middle C
    expect(noteNamesToPeriod.C7).toBeCloseTo(1 / 4186.01); // Highest C
  });

  it('should have equivalent values for enharmonic notes', () => {
    // Test sharp/flat equivalences
    expect(noteNameToFreq['A#4']).toBe(noteNameToFreq.Bb4);
    expect(noteNamesToPeriod['A#4']).toBe(noteNamesToPeriod.Bb4);
  });

  it('should maintain ascending frequency order', () => {
    const entries = Object.entries(noteNameToFreq);

    // Define the type explicitly for the breaks array
    const breaks: {
      prev: { note: string; freq: number };
      curr: { note: string; freq: number };
    }[] = [];

    for (let i = 1; i < entries.length; i++) {
      const [prevNote, prevFreq] = entries[i - 1];
      const [currNote, currFreq] = entries[i];

      if (currFreq < prevFreq) {
        breaks.push({
          prev: { note: prevNote, freq: prevFreq },
          curr: { note: currNote, freq: currFreq },
        });
      }
    }

    if (breaks.length > 0) {
      console.log('Frequency order breaks at:');
      const breakMessages = breaks.map(
        ({ prev, curr }) =>
          `${prev.note}(${prev.freq}Hz) -> ${curr.note}(${curr.freq}Hz)`
      );
      console.log(breakMessages.join('\n'));
    }

    expect(breaks).toHaveLength(0);
  });
});
