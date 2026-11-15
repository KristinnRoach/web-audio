import { assert } from '@/utils';

export type RenderOfflineOptions = {
  /** Length of the render in seconds */
  duration: number;
  sampleRate?: number;
  numberOfChannels?: number;
};

/** Renders what `setup` builds on a new OfflineAudioContext, faster than real time.
 *  `setup` runs while rendering is suspended at frame 0, so the notes and settings it
 *  sends reach the audio thread before the first frame. Schedule later notes with
 *  play()'s `secondsFromNow`. */
export async function renderOffline(
  setup: (context: OfflineAudioContext) => void | Promise<void>,
  { duration, sampleRate = 48000, numberOfChannels = 2 }: RenderOfflineOptions,
): Promise<AudioBuffer> {
  assert(duration > 0 && Number.isFinite(duration), `duration must be > 0, got ${duration}`);
  const context = new OfflineAudioContext({
    numberOfChannels,
    length: Math.ceil(duration * sampleRate),
    sampleRate,
  });
  const ready = context.suspend(0).then(async () => {
    try {
      await setup(context);
    } finally {
      void context.resume();
    }
  });
  // A setup error still lets the render finish, then rejects here
  const [buffer] = await Promise.all([context.startRendering(), ready]);
  return buffer;
}
