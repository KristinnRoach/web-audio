import { describe, expect, it } from 'vite-plus/test';
import { envelopePresets } from '../envelope-presets';
import { assertValidEnvelopeShape } from '../envelope-shape';

describe('envelopePresets', () => {
  it.each(Object.entries(envelopePresets))(
    '%s returns a valid shape ending at the requested duration',
    (_, preset) => {
      const shape = preset(4);
      expect(() => assertValidEnvelopeShape(shape)).not.toThrow();
      expect(shape.points.at(-1)!.time).toBe(4);
    },
  );

  it('rejects invalid durations', () => {
    expect(() => envelopePresets.amplitude(0)).toThrow(RangeError);
  });
});
