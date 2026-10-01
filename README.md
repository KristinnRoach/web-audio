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

`getOrCreateGlobalAudioContext()` returns the library singleton synchronously,
creating it if needed (or replacing a closed one). It can be suspended; the next
click, touch or key press resumes it. To wait until audio runs, call
`await context.resume()` in your own gesture handler.

`configureGlobalAudioContext(options)` takes standard `AudioContextOptions`
(`sampleRate`, `latencyHint`) and merges them into the current ones.
It can be called any time. If the singleton exists and an option changes, it is
closed and replaced, since an `AudioContext`'s options are fixed at construction.
Nodes built on the old context stop working, so rebuild them on the returned one.
It returns `null` when no singleton exists yet.

```ts
import {
  configureGlobalAudioContext,
  getOrCreateGlobalAudioContext,
  isGlobalAudioContext,
} from '@kidlib/web-audio';

configureGlobalAudioContext({ sampleRate: 48_000 });
const context = getOrCreateGlobalAudioContext();
console.log(isGlobalAudioContext(context)); // true

// Later, e.g. to match an external device's rate:
const next = configureGlobalAudioContext({ sampleRate: 44_100 });
if (next) player = await createSamplePlayer({ context: next });
```

`isGlobalAudioContext(context)` checks identity against the current library
singleton without creating one. A caller-created context returns false.
The player and recorder factories use a supplied context, or the global singleton
when omitted. Voices, buses, reverb, and feedback require an explicit context.
`createPitchDivideEffect(context, audioBuffer, divider)` also requires a context.

`getAudioContext` was renamed `getOrCreateGlobalAudioContext`, and
`ensureAudioCtx` was removed; update existing imports.
