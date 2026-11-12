# @kidlib/web-audio

High-level Web Audio primitives for creating musical instruments and tools.
This package requires a browser with Web Audio and AudioWorklet support.

## Install

```sh
pnpm add @kidlib/web-audio
```

## Usage

```ts
import { createSamplePlayer } from '@kidlib/web-audio';
import { inputController } from '@kidlib/web-audio/io';

const response = await fetch('/samples/kick.wav');
if (!response.ok) {
  throw new Error(`Failed to fetch sample: ${response.status} ${response.statusText}`);
}
const sampleData = await response.arrayBuffer();
const player = await createSamplePlayer({ audio: sampleData });
player.play(60);
```

## Recording

`createAudioRecorder()` records takes into an `AudioBuffer`. Takes go through
`MediaRecorder`, so they are encoded and decoded on the way
([lossless capture is tracked here](https://github.com/KristinnRoach/web-audio/issues/166)).

```ts
import { createAudioRecorder } from '@kidlib/web-audio';

const recorder = createAudioRecorder();
recorder.onMessage('record:stop', ({ buffer }) => player.loadAudio(buffer));

// Record now, stop by hand. stop() resolves null if nothing was recording.
await recorder.start();
// Later, when the user presses Stop:
const buffer = await recorder.stop();

// Wait for sound, then stop after a second below -50 dB.
await recorder.arm({
  startThresholdDb: -30,
  stopOnSilence: { thresholdDb: -50, durationMs: 1000 },
});
// recorder.start() records the armed take without waiting.
```

`input` picks the source; the microphone is the default. One of:

```ts
recorder.start({ input: { type: 'microphone', deviceId, constraints: { channelCount: 2 } } });
recorder.start({ input: { type: 'display' } }); // tab or screen audio
recorder.start({ input: { type: 'audio-node', node: synthOutput } });
recorder.start({ input: { type: 'stream', stream } }); // its tracks are left running
```

`cancel()` discards a take at any stage. `state-change` reports `IDLE`,
`REQUESTING_INPUT`, `ARMED`, `RECORDING` and `FINALIZING`; failures arrive on
`record:error`. Input acquisition failures also reject `start()`/`arm()`;
capture or decode failures reject a pending `stop()`. Cancelling settles pending
startup calls and resolves a pending `stop()` with `null`, even while permission
or decoding is still pending. The browser's permission prompt itself cannot be
closed by the recorder; any input granted later is released.

### Live demo app: [Hljóð-Smali](https://kristinnroach.github.io/hljod-smali)

## Global audio context

Factories use the library's global `AudioContext` unless you pass `{ context }`.
It may start suspended; the first click, touch or key press resumes it.

To set options such as `sampleRate`, call `createGlobalAudioContext(options)`
before anything uses the global context; it throws while one is open. Nodes
can't move between contexts, so a later change means rebuilding:

```ts
import { createGlobalAudioContext, createSamplePlayer } from '@kidlib/web-audio';

createGlobalAudioContext({ sampleRate: savedRate }); // at startup
let player = await createSamplePlayer({ audio: sampleData });

async function setSampleRate(sampleRate: number) {
  player.dispose();
  await player.context.close(); // state is only 'closed' once this resolves
  createGlobalAudioContext({ sampleRate });
  player = await createSamplePlayer({ audio: sampleData });
}
```

The output device set with `setAudioOutputDevice` does not carry over to the new
context.
