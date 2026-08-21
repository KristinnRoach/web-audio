# @kidlib/web-audio

High-level Web Audio primitives for creating musical instruments and tools.
This package requires a browser with Web Audio and AudioWorklet support.

## Install

```sh
pnpm add @kidlib/web-audio
```

## Usage

```ts
import { createSamplePlayer } from "@kidlib/web-audio";
import { inputController } from "@kidlib/web-audio/io";
import { registerKnobElement } from "@kidlib/web-audio/components";

const response = await fetch("/samples/kick.wav");
if (!response.ok) {
  throw new Error(`Failed to fetch sample: ${response.status} ${response.statusText}`);
}
const sampleData = await response.arrayBuffer();
const player = await createSamplePlayer(sampleData);
player.play(60);
```

UI elements such as `KnobElement` are available only from the optional
`@kidlib/web-audio/components` entry point.

### Live demo app: [Hljóð-Smali](https://kristinnroach.github.io/hljod-smali)
