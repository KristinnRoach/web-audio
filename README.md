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

// Wait for sound, then stop after 600 ms below -36 dB.
await recorder.arm({
  startThresholdDb: -30,
  stopOnSilence: true,
});
// recorder.start() records the armed take without waiting.
```

`stopOnSilence: true` derives its stop threshold 6 dB below the start threshold
and waits for **600 ms of continuous silence**. Sound above the stop threshold
resets the wait. Silence only counts once the take has had sound, so `start()`
in a quiet room keeps recording until something is played. The silence wait is
included in the buffer unless `trim: true` cuts it off. Omit `stopOnSilence` or
pass `false` to stop manually. Override any setting independently, for example
`stopOnSilence: { durationMs: 1000 }` for longer pauses or
`stopOnSilence: { thresholdDb: -50, durationMs: 1000, trim: true }` for full control.

For a UI meter and one sensitivity slider, opt into level events:

```ts
const unsubscribe = recorder.onMessage('record:level', ({ peakDb, rmsDb }) => {
  updateMeter(peakDb, rmsDb); // Your UI; clamp -Infinity (digital silence) for display.
});
await recorder.arm({ startThresholdDb: -30, stopOnSilence: true, metering: true });

// On sensitivity changes while waiting for sound:
if (recorder.isArmed) recorder.setStartThresholdDb(-36);
// The derived stop threshold follows to -42 dB; explicit stop thresholds stay fixed.

// When removing the UI subscription:
unsubscribe();
```

`record:level` also includes the effective `startThresholdDb` and `stopThresholdDb`
(`null` when silence stopping is off). Readings are sampled peak/RMS levels in
dBFS, approximately every 20 ms while armed or recording; background tabs can
slow updates. They reuse the detection analyser. A manual recording only creates
an analyser if silence stopping or metering is enabled. `setStartThresholdDb()`
also works while an armed take is requesting input; it rejects once recording
starts and does not change future takes. An explicit stop threshold must remain
below the new start threshold.

Set the stop threshold above room noise so the take can finish. Fixed defaults
cannot suit every environment, so the recorder can measure the room and show a
meter before anything is armed:

```ts
// "Auto" button: listen for 800 ms and suggest a threshold 12 dB above the noise.
const measured = await recorder.measureNoiseFloor(); // null if cancelled
if (measured) startThresholdDb = measured.startThresholdDb;

// Mic toggle: a live meter with no risk of starting a take.
await recorder.monitor(); // record:level events, state MONITORING
recorder.cancel(); // or arm()/start(), which reuse the open input

await recorder.arm({ startThresholdDb, stopOnSilence: true, metering: true });
```

`measureNoiseFloor()` takes the 95th percentile of the sampled peaks as the
noise floor, so one click does not set it, and returns `noiseFloorDb`,
`startThresholdDb` and `stopThresholdDb` (6 dB lower). Nothing is applied for
you. Digital silence suggests -60 dB; a suggestion near 0 dB means the room is
too loud to trigger reliably. `durationMs` and `marginDb` are adjustable. It
opens input for the measurement when idle, and keeps monitoring when called
while monitoring. Thresholds stay fixed for the take; the recorder does not
adapt them while armed. During monitoring `record:level` reports
`startThresholdDb: null`, and a take that finishes ends the monitoring it
started from. [examples/recorder](examples/recorder/index.html) is a minimal
record/meter/play widget built on these calls.

`input` picks the source; the microphone is the default. One of:

```ts
recorder.start({ input: { type: 'microphone', deviceId, constraints: { channelCount: 2 } } });
recorder.start({ input: { type: 'display' } }); // tab or screen audio
recorder.start({ input: { type: 'audio-node', node: synthOutput } });
recorder.start({ input: { type: 'stream', stream } }); // its tracks are left running
```

Display input accepts native `getDisplayMedia()` options without translating their names:

```ts
await recorder.arm({
  input: {
    type: 'display',
    options: { preferCurrentTab: true, audio: { suppressLocalAudioPlayback: false } },
  },
});
```

Unspecified options default to `audio: true`, `video: true`,
`audioSelection: 'preferred'`, `systemAudio: 'include'` and `windowAudio: 'window'`.
The browser requires video for this API; Recorder immediately stops its video
tracks and only retains audio. Picker hints depend on browser/OS support and do
not guarantee audio; a selection without an audio track rejects the call.
Explicit options are passed through, including `false` values (although the
browser rejects `video: false`, and `audio: false` produces no recordable audio).

An explicit microphone `deviceId` is required to match: if unavailable, the call
rejects instead of opening a different microphone. The app decides whether to
retry with the default input. Device-list helpers in `@kidlib/web-audio/io` only
enumerate; they do not request microphone or camera access. Device labels and
the available list may be limited until the app obtains capture permission.

`cancel()` discards a take at any stage and ends monitoring. `state-change` reports
`IDLE`, `REQUESTING_INPUT`, `MONITORING`, `ARMED`, `RECORDING` and `FINALIZING`; failures arrive on
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
