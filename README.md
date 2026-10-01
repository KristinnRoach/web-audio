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

`getGlobalAudioContext()` returns the library singleton synchronously, creating
it if needed; it can still be suspended. `ensureGlobalAudioContext()` uses the
existing user-interaction auto-resume flow and recreates a closed singleton.
Call `configureGlobalAudioContext(config)` before creating the singleton to set
its sample rate and latency hint. Configuration passed to either getter only
applies when creating a context.

```ts
import {
  configureGlobalAudioContext,
  getGlobalAudioContext,
  isGlobalAudioContext,
} from '@kidlib/web-audio';

configureGlobalAudioContext({ sampleRate: 48_000 });
const context = getGlobalAudioContext();
console.log(isGlobalAudioContext(context)); // true
```

`isGlobalAudioContext(context)` checks identity against the current library
singleton without creating one. A caller-created context returns false.
Factories accepting a context use the supplied instance; omitting it selects
the global singleton where documented.

The global helpers were renamed from `getAudioContext`, `ensureAudioCtx`, and
`configureAudioContext`; update existing imports to the names above.
