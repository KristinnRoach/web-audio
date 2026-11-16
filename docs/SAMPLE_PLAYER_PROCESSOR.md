# SamplePlayer ↔ SamplePlayerProcessor

The contract between `SamplePlayer` (main thread, `src/nodes/instruments/Sample/SamplePlayer.ts`) and its `SamplePlayerProcessor` (`src/worklets/processors/play/sample-player-processor.js`), as of [migration](SAMPLE_PLAYER_VOICE_MIGRATION.md) step 5. The processor holds the pitch settings and works out every note's playback rate; no main → processor message carries a rate.

## Node

`createSampleWorklet(context, voiceCount)` in `SampleVoice.ts`; `voiceCount` is the player's `polyphony` (default 16).

- `processorOptions: { voiceCount }`, `numberOfInputs: 0`, `numberOfOutputs: voiceCount * 2`.
- Output `2i`: voice `i`'s stereo audio. Output `2i + 1`: voice `i`'s filter envelope in cents (mono), connected to that voice's `lpf.detune`; silent when the envelope is off.
- AudioParams (`masterGain`, `pan`, `playbackRate`, `detune`, `loopStart`, `loopEnd`, `startPoint`, `endPoint`, `loopDurationDriftAmount`, `maxLoopCount`) belong to the node and are shared by every voice. The player sets each once.

## The `voice` tag

- Main → processor: a message with `voice: i` goes to voice `i`; one without `voice` goes to every voice. `pool:*` messages go to the allocator and ignore the tag.
- Processor → main: every report except `initialized` carries the `voice` index it came from. `SamplePlayer` hands a tagged report to `voices[voice]` and an untagged one to all voices.
- `SamplePlayer` posts untagged. Only `SampleVoice.sendToProcessor` tags: `voice:stop` from a player's voice, and the messages of a stand-alone `SampleVoice`.

## Main → processor

| type                           | fields                                                                                      | tag      | sent by                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `pool:noteOn`                  | `triggerId`, `timestamp`, `midiNote`, `velocity`, `glideTime`                               | untagged | `play()`                                                                            |
| `pool:noteOff`                 | `midiNote`, `timestamp`                                                                     | untagged | `release()`                                                                         |
| `pool:allNotesOff`             | `timestamp`                                                                                 | untagged | `releaseAll()`, so also every load and `dispose()`                                  |
| `pool:setLegato`               | `value: LegatoSettings`                                                                     | untagged | `init()`, `setLegato()`                                                             |
| `pool:setPitchOffset`          | `value` (semitones: transpose + fine tune)                                                  | untagged | `init()`, `transpose()`, `fineTune()`, `commitPitch()`                              |
| `pool:setPitchEnabled`         | `value: boolean`                                                                            | untagged | `init()`, `setPitchEnabled()`                                                       |
| `voice:setBuffer`              | `buffer: Float32Array[]` (one per channel), `durationSeconds`                               | untagged | `loadAudio()`, `cropSample()`, `commitPitch()`                                      |
| `voice:setZeroCrossings`       | `zeroCrossings: number[]`                                                                   | untagged | same, when preprocessing found any                                                  |
| `voice:setPitchPeriods`        | `periods`, `hopSamples`                                                                     | untagged | once per load while timestretch is `'period'`, or on switching to it                |
| `setLoopQuantizePeriods`       | `value: number[]` (seconds)                                                                 | untagged | `init()`, `setLoopPitchQuantization()`                                              |
| `setEnvelope`                  | `target: 'gain' \| 'detune' \| 'pan' \| 'filter'`, `value`: resolved config or `null` (off) | untagged | processor `initialized`, `updateEnvelope()`; `filter` only when the chain has `lpf` |
| `setLoopLengthGlide`           | `value` (seconds)                                                                           | untagged | processor `initialized`, `setLoopLengthGlide()`                                     |
| `setLoopPositionGlide`         | `value` (seconds)                                                                           | untagged | processor `initialized`, `setLoopPositionGlide()`                                   |
| `voice:reportPlaybackPosition` | `value: boolean`                                                                            | untagged | processor `initialized`, `enablePositionTracking()`                                 |
| `setLoopEnabled`               | `value: boolean`                                                                            | untagged | `setLoopEnabled()`, sustain pedal                                                   |
| `setLoopPingPong`              | `value: boolean`                                                                            | untagged | `setLoopPingPong()`                                                                 |
| `setKeytrackLoopAmount`        | `value` (0..1)                                                                              | untagged | `setKeytrackLoopAmount()`                                                           |
| `setPanDriftEnabled`           | `value: boolean`                                                                            | untagged | `setPanDriftEnabled()`                                                              |
| `voice:setPlaybackDirection`   | `playbackDirection: 'forward' \| 'reverse'`                                                 | untagged | `setPlaybackDirection()`                                                            |
| `setTimestretchMode`           | `value: 'off' \| 'period'`                                                                  | untagged | `setTimestretchMode()`                                                              |
| `setInterpolation`             | `value: 'linear' \| 'hermite' \| 'sinc'`                                                    | untagged | `init()` if set before it, `setInterpolation()`                                     |
| `voice:stop`                   | `timestamp`                                                                                 | tagged   | `SampleVoice.dispose()` of a voice that is still sounding                           |

The processor also handles `voice:start` (`triggerId`, `timestamp`, `midiNote`, `velocity`, `glideTime`, `glideFromNote`) and `voice:release` (tagged). `SamplePlayer` does not send them; they serve a stand-alone `SampleVoice`. `voice:start` gets its rate from the pool like a `pool:noteOn`.

## Processor → main

| type              | fields                                                                                                    | notes                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `initialized`     | none                                                                                                      | untagged, once, from the constructor. The player then posts the settings marked above.         |
| `voice:loaded`    | `durationSeconds`, `time`                                                                                 | one per voice per `voice:setBuffer`. The player emits `sample:loaded` after the last one.      |
| `voice:started`   | `triggerId`, `midiNote`, `velocity`, `timestamp`, `glideTime`, `glideFromNote`                            | allocator picked this voice; posted before the engine starts, so it precedes its reports.      |
| `voice:retuned`   | `midiNote`, `velocity`, `timestamp`, `glideTime`, `fallback`                                              | legato retune, rate already set; `fallback` means a note-off returned to an earlier held note. |
| `voice:releasing` | none                                                                                                      |                                                                                                |
| `voice:ended`     | `triggerId`                                                                                               | the note finished, or a buffer swap dropped it. The voice emits `voice:stopped`.               |
| `loop:enabled`    | `enabled`                                                                                                 | echo of `setLoopEnabled`, once per voice.                                                      |
| `loop:range`      | `loopStart`, `loopEnd`, `triggerId`; playing: `loopMode`, `isInPitchLoop`; idle: `keytrackAmount`, `idle` | throttled; `idle` reports describe the next note and are dropped on the main thread.           |
| `trim:range`      | `startPoint`, `endPoint`, `inverted`, `triggerId`                                                         | throttled.                                                                                     |
| `voice:position`  | `position` (0..1), `triggerId`                                                                            | ~60 Hz, only while position tracking is on.                                                    |

## Pitch

- `VoicePool` holds the pitch offset and whether pitch is on. A played note's rate is `midiToPlaybackRate(midiNote + offset)` (reference note 60), or 1 with pitch off. It computes the rate of a started note and its glide origin, of legato and fallback retunes, and of a `voice:start`. Pitch off also means no glide.
- The glide origin is the last note applied, or the earlier held note a fallback returned to; 60 before the first note. `glideFromNote` in `voice:started` is that played note, `null` without glide; the voice adds its offset for its effects.
- A setting change retunes at the processor's `currentTime` when handled: a new offset moves voices that have a note with a 0.01 s time constant (0 while pitch is off); pitch off sends every voice to rate 1 with 0.1/3; pitch on retunes voices that have a note with 0.01/3.
- `SampleVoice` keeps its own copy of the offset only for its main-thread effects (feedback, AM LFO).

## Ordering the code relies on

- The port is FIFO. `voice:setBuffer` is posted before any `pool:noteOn` meant for it, so the note never reaches a voice without its audio; `play()` checks only that a buffer was posted, not that `voice:loaded` came back.
- `pool:allNotesOff` goes out before `voice:setBuffer`. Notes scheduled on the old buffer go with it.
- `voice:setPitchPeriods` follows `voice:setBuffer`: a new buffer clears the periods.
- Settings posted before `initialized` arrive are queued and applied in order; `initialized` only tells the player its voices are on defaults and need the player's envelopes, glides and position tracking.
- `voice:started` is posted before the voice's first `loop:range`/`trim:range`, so the main thread knows the note's `triggerId` before ranges for it arrive.

## Usage

```ts
// SamplePlayer.init(), shortened
const worklet = createSampleWorklet(context, polyphony);
const voices = Array.from(
  { length: polyphony },
  (_, voiceIndex) => new SampleVoice(context, { worklet, voiceIndex }),
);
worklet.port.onmessage = ({ data }) => {
  for (const voice of data.voice === undefined ? voices : [voices[data.voice]]) {
    voice.receive(data); // e.g. voice:started → state PLAYING, then forwarded upstream
  }
};

// play(60): untagged, the processor picks the voice when the note is due
worklet.port.postMessage({
  type: 'pool:noteOn',
  triggerId: 1,
  timestamp: context.currentTime,
  midiNote: 60,
  velocity: 100,
  glideTime: 0,
});
// ...later: { type: 'voice:started', voice: 3, triggerId: 1, midiNote: 60, ... }
```
