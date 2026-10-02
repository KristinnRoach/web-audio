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
import { registerKnobElement } from '@kidlib/web-audio/components';

const response = await fetch('/samples/kick.wav');
if (!response.ok) {
  throw new Error(`Failed to fetch sample: ${response.status} ${response.statusText}`);
}
const sampleData = await response.arrayBuffer();
const player = await createSamplePlayer(sampleData);
player.play(60);
```

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
let player = await createSamplePlayer(sampleData);

async function setSampleRate(sampleRate: number) {
  player.dispose();
  await player.context.close(); // state is only 'closed' once this resolves
  createGlobalAudioContext({ sampleRate });
  player = await createSamplePlayer(sampleData);
}
```

The output device set with `setAudioOutputDevice` does not carry over to the new
context.
