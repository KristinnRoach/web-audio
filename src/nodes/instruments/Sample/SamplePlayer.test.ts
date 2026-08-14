import { describe, expect, it, vi } from 'vitest';
import type { SamplePlayer } from './SamplePlayer';

describe('SamplePlayer.applyParams', () => {
  it('applies only valid parameter values', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('AudioWorkletNode', class {});
    const { SamplePlayer } = await import('./SamplePlayer');
    const player = {
      setVolume: vi.fn(),
      setGlideTime: vi.fn(),
      setTempo: vi.fn(),
      setFeedbackPitchScale: vi.fn(),
    } as unknown as SamplePlayer;

    SamplePlayer.prototype.applyParams.call(player, {
      volume: 0.75,
      glide: 0.2,
      unknown: 1,
      tempo: 301,
      feedbackPitch: 0.3,
    } as never);

    expect(player.setVolume).toHaveBeenCalledWith(0.75);
    expect(player.setGlideTime).toHaveBeenCalledWith(0.2);
    expect(player.setTempo).not.toHaveBeenCalled();
    expect(player.setFeedbackPitchScale).not.toHaveBeenCalled();
  });
});
