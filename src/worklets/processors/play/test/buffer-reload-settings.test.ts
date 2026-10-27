import { describe, expect, it } from 'vite-plus/test';
import {
  makeParameters,
  render,
  setupProcessorGlobals,
  startProcessor,
} from './range-test-helpers';

describe('buffer reload settings', () => {
  setupProcessorGlobals();

  it.each(['voice:setBuffer', 'voice:setAudioData'])(
    '%s preserves user settings while clearing playback state',
    async (type) => {
      const processor = await startProcessor();
      const send = (data: object) => processor.port.onmessage?.({ data } as MessageEvent);
      send({ type: 'voice:setPlaybackDirection', playbackDirection: 'reverse' });
      send({ type: 'setPanDriftEnabled', value: false });
      render(processor, makeParameters(), 2);
      expect(processor.playbackPosition).toBeGreaterThan(0);

      const buffer = [new Float32Array(480)];
      send({ type, buffer, audioData: [buffer], durationSeconds: 0.01 });

      expect(processor).toMatchObject({
        loopEnabled: true,
        reversePlayback: true,
        panDriftEnabled: false,
        isPlaying: false,
        playbackPosition: 0,
        loopCount: 0,
        previousLoopRange: null,
      });

      // The saved direction also applies to the newly loaded audio.
      send({ type: 'voice:start' });
      render(processor, makeParameters(), 1);
      expect(processor.playbackPosition).toBe(478);
    },
  );
});
