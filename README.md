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

### Experimental timestretch crossfade

```ts
player.setTimestretchEnabled(true);
player.setCrossfadeDurationMs(5); // On by default; see duration-preservation.js
// A/B against the original zero-crossing jumps:
player.setCrossfadeDurationMs(0);
```

The experiment overlaps advancing audio for the configured duration at preservation jumps,
using smooth equal-gain fades for the slope-matched crossings. Fades shorten near
trim/loop boundaries and at high playback rates, and reset with the voice. It adds no playback delay and does
not change the existing timestretch eligibility rules. Overlaps can soften
transients or cause phase cancellation; compare with your own samples.

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
