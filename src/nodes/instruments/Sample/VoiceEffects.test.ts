import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

const effects = vi.hoisted(() => ({
  setMusicalNote: vi.fn(),
  trigger: vi.fn(),
  setPitch: vi.fn(),
}));

vi.mock('@/nodes/modulators/LFO/LFO', () => ({
  LFO: class {
    setWaveform() {}
    setDepth() {}
    connect() {}
    setMusicalNote = effects.setMusicalNote;
  },
}));

vi.mock('@/nodes/effects/HarmonicFeedback', () => ({
  HarmonicFeedback: class {
    input = { connect() {} };
    output = { connect() {} };
    trigger = effects.trigger;
    setPitch = effects.setPitch;
  },
}));

class FakeNode {
  gain = {};
  frequency = {};
  detune = {};
  Q = {};
  connect() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('window', {});
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('AudioWorkletNode', class {});
  vi.stubGlobal('GainNode', FakeNode);
  vi.stubGlobal('BiquadFilterNode', FakeNode);
});
afterEach(() => vi.unstubAllGlobals());

const context = { currentTime: 0, sampleRate: 48000 } as unknown as AudioContext;

it('rejects duplicate nodes', async () => {
  const { VoiceEffects } = await import('./VoiceEffects');
  expect(() => new VoiceEffects(context, {} as AudioWorkletNode, 0, ['lpf', 'lpf'])).toThrow(
    'Voice signal chain cannot contain duplicate nodes',
  );
});

it('unregisters itself when wiring fails', async () => {
  const { VoiceEffects } = await import('./VoiceEffects');
  const { getNodesByType } = await import('../../node-store');
  const before = getNodesByType('sample-voice').length;
  const worklet = {
    connect() {
      throw new Error('no such output');
    },
  };
  expect(() => new VoiceEffects(context, worklet as never, 0, ['lpf'])).toThrow('no such output');
  expect(getNodesByType('sample-voice')).toHaveLength(before);
});

it('wires its two processor outputs and follows notes with the pitch offset', async () => {
  const { VoiceEffects } = await import('./VoiceEffects');
  const worklet = { connect: vi.fn() };
  const voice = new VoiceEffects(context, worklet as never, 1, ['am', 'feedback', 'lpf']);
  const { worklet: source, lpf } = voice.getGainStages();
  expect(worklet.connect.mock.calls).toEqual([
    [source, 2],
    [(lpf as BiquadFilterNode).detune, 3],
  ]);

  // No held note: only the offset is kept.
  voice.setPitchOffset(2, null);
  expect(effects.setPitch).not.toHaveBeenCalled();

  // The AM LFO sits an octave above the sounding note by default.
  voice.followNote(60, { velocity: 90, timestamp: 1, glideTime: 0.2, glideFromNote: 55 });
  expect(effects.trigger).toHaveBeenLastCalledWith(62, {
    velocity: 90,
    secondsFromNow: 1,
    glideTime: 0.2,
    triggerDecay: true,
  });
  expect(effects.setMusicalNote).toHaveBeenLastCalledWith(74, {
    divisor: 1,
    glideTime: 0.2,
    glideFromMidiNote: 69,
    timestamp: 1,
  });

  // A retune moves the sounding note without retriggering.
  voice.followNote(64, { timestamp: 2, glideTime: 0.1 });
  expect(effects.trigger).toHaveBeenCalledOnce();
  expect(effects.setPitch).toHaveBeenLastCalledWith(66, 0, 2, 0.1);
  expect(effects.setMusicalNote).toHaveBeenLastCalledWith(78, { timestamp: 2, glideTime: 0.1 });

  voice.setPitchOffset(-3, 64);
  expect(effects.setPitch).toHaveBeenLastCalledWith(61, 0, 0, 0.01);
  expect(effects.setMusicalNote).toHaveBeenLastCalledWith(73, { timestamp: 0, glideTime: 0.01 });
});
