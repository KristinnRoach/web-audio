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

`getGlobalAudioContext()` returns the library's global `AudioContext`
synchronously, creating it on first use (or replacing a closed one). It can be
suspended; the next click, touch or key press resumes it. To wait until audio
runs, call `await context.resume()` in your own gesture handler.

`configureGlobalAudioContext(options)` sets the global context's standard
`AudioContextOptions` (unset ones use the library defaults). Before first use
it only stores them. Afterwards, changed options replace the global context:
the library closes the previous one, so every player and node built on it
stops. Rebuild them, and consider confirming with the user first if audio may
be playing. Calling it with unchanged options does nothing.

```ts
import { configureGlobalAudioContext, createSamplePlayer } from '@kidlib/web-audio';

configureGlobalAudioContext({ sampleRate: savedRate }); // at startup; creates no context yet
let player = await createSamplePlayer(sampleData);

async function setSampleRate(sampleRate: number) {
  player.dispose();
  configureGlobalAudioContext({ sampleRate });
  player = await createSamplePlayer(sampleData); // uses the new context
}
```

To keep a context under your own control, create it yourself and pass it to the
factories with `{ context }`; the library never closes it.

The player and recorder factories use a supplied context, or the global one
when omitted. Voices, buses, reverb, and feedback require an explicit context.
`createPitchDivideEffect(context, audioBuffer, divider)` also requires a context.

`getAudioContext` was renamed `getGlobalAudioContext`, and `ensureAudioCtx`
was removed; update existing imports.
