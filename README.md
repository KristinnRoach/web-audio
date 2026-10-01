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

`getOrCreateGlobalAudioContext()` returns the library singleton synchronously, creating
it if needed; it can still be suspended. `ensureGlobalAudioContext()` uses the
existing user-interaction auto-resume flow and recreates a closed singleton.
Call `configureGlobalAudioContext(config)` before creating the singleton to set
its sample rate and latency hint. Both `getOrCreateGlobalAudioContext()` and
`ensureGlobalAudioContext()` use these configured global defaults.

```ts
import {
  configureGlobalAudioContext,
  getOrCreateGlobalAudioContext,
  isGlobalAudioContext,
} from '@kidlib/web-audio';

configureGlobalAudioContext({ sampleRate: 48_000 });
const context = getOrCreateGlobalAudioContext();
console.log(isGlobalAudioContext(context)); // true
```

`isGlobalAudioContext(context)` checks identity against the current library
singleton without creating one. A caller-created context returns false.
The player and recorder factories use a supplied context, or the global singleton
when omitted. Voices, buses, reverb, and feedback require an explicit context.
`createPitchDivideEffect(context, audioBuffer, divider)` also requires a context.

The global helpers were renamed from `getAudioContext`, `ensureAudioCtx`, and
`configureAudioContext`; update existing imports to the names above.
