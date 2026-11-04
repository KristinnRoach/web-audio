import { expect, test } from 'vite-plus/test';
import { LibAudioNode } from '../LibAudioNode';
import { initProcessors } from '@/worklets/init-processors';
import { HarmonicFeedback } from './HarmonicFeedback';
import { DattorroReverb } from './DattorroReverb';

test.each([HarmonicFeedback, DattorroReverb])(
  '%s keeps each incoming source ID until that source disconnects',
  async (Effect) => {
    const context = new AudioContext();
    let effect: HarmonicFeedback | DattorroReverb | undefined;
    const sources = [0, 1].map(() => new LibAudioNode(new GainNode(context), context, 'GainNode'));
    try {
      await initProcessors(context);
      effect = new Effect(context);
      sources.forEach((source) => source.connect(effect!));
      expect(effect.connections.incoming).toEqual(sources.map((source) => source.nodeId));

      sources[0].disconnect(effect);
      expect(effect.connections.incoming).toEqual([sources[1].nodeId]);

      sources[1].disconnect(effect);
      expect(effect.connections.incoming).toEqual([]);
    } finally {
      sources.forEach((source) => source.dispose());
      effect?.dispose();
      await context.close();
    }
  },
);
