# SamplePlayer ↔ SamplePlayerProcessor

The contract between `SamplePlayer` (main thread, `src/nodes/instruments/Sample/SamplePlayer.ts`) and its `SamplePlayerProcessor` (`src/worklets/processors/play/sample-player-processor.js`), as of [migration](SAMPLE_PLAYER_VOICE_MIGRATION.md) step 4b. The processor holds the pitch settings and works out every note's playback rate; no main → processor message carries a rate.

## Node

`createSampleWorklet(context, voiceCount)` in `SamplePlayer.ts`; `voiceCount` is the player's `polyphony` (default 16).

- `processorOptions: { voiceCount }`, `numberOfInputs: 0`, `numberOfOutputs: voiceCount * 2`.
- Output `2i`: voice `i`'s stereo audio. Output `2i + 1`: voice `i`'s filter envelope in cents (mono), connected to that voice's `lpf.detune`; silent when the envelope is off.
- AudioParams (`masterGain`, `pan`, `playbackRate`, `detune`, `loopStart`, `loopEnd`, `startPoint`, `endPoint`, `loopDurationDriftAmount`, `maxLoopCount`) belong to the node and are shared by every voice. `SamplePlayer` sets them on its worklet: `startPoint`, `endPoint`, `loopStart`, `loopEnd` (both at one event time when set together) and `loopDurationDriftAmount`; the pitch LFO drives `detune`.

## The `voice` tag

- Main → processor: a voice message with `voice: i` goes to voice `i`; one without `voice` goes to every voice. `pool:*` and `flush` are node-wide and ignore the tag.
- Processor → main: every report except `initialized` and `flushed` carries the `voice` index it came from. `SamplePlayer` applies it to its record `voices[voice]`.
- `SamplePlayer` posts only untagged messages. Tagged messages remain for the engine tests in `src/worklets/processors/play/test/`, which drive voices directly.

## Main → processor

| type                           | fields                                                                                      | tag      | sent by                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `flush`                        | `id`                                                                                        | untagged | `flushMessages()`                                                                   |
| `pool:noteOn`                  | `triggerId`, `timestamp`, `midiNote`, `velocity`, `glideTime`                               | untagged | `play()`                                                                            |
| `pool:noteOff`                 | `midiNote`, `timestamp`                                                                     | untagged | `release()`                                                                         |
| `pool:allNotesOff`             | `timestamp`                                                                                 | untagged | `releaseAll()`, so also every load and `dispose()`                                  |
| `pool:setLegato`               | `value: LegatoSettings`                                                                     | untagged | `init()`, `setLegato()`                                                             |
| `pool:setPitchOffset`          | `value` (semitones: transpose + fine tune)                                                  | untagged | `init()`, `transpose()`, `fineTune()`, `commitPitch()`                              |
| `pool:setPitchEnabled`         | `value: boolean`                                                                            | untagged | `init()`, `setPitchEnabled()`                                                       |
| `voice:setBuffer`              | `buffer: Float32Array[]` (one per channel), `durationSeconds`                               | untagged | `loadAudio()`, `cropSample()`, `commitPitch()`                                      |
| `voice:setZeroCrossings`       | `zeroCrossings: number[]`                                                                   | untagged | same, when preprocessing found any                                                  |
| `voice:setPitchPeriods`        | `periods`, `hopSamples`                                                                     | untagged | once per load while timestretch is `'period'`, or on switching to it                |
| `voice:setLoopQuantizePeriods` | `value: number[]` (seconds)                                                                 | untagged | `init()`, `setLoopPitchQuantization()`                                              |
| `voice:setEnvelope`            | `target: 'gain' \| 'detune' \| 'pan' \| 'filter'`, `value`: resolved config or `null` (off) | untagged | processor `initialized`, `updateEnvelope()`; `filter` only when the chain has `lpf` |
| `voice:setLoopLengthGlide`     | `value` (seconds)                                                                           | untagged | processor `initialized`, `setLoopLengthGlide()`                                     |
| `voice:setLoopPositionGlide`   | `value` (seconds)                                                                           | untagged | processor `initialized`, `setLoopPositionGlide()`                                   |
| `voice:reportPlaybackPosition` | `value: boolean`                                                                            | untagged | processor `initialized`, `enablePositionTracking()`                                 |
| `voice:setLoopEnabled`         | `value: boolean`                                                                            | untagged | `init()`, `setLoopEnabled()`, sustain pedal                                         |
| `voice:setLoopPingPong`        | `value: boolean`                                                                            | untagged | `setLoopPingPong()`                                                                 |
| `voice:setStartFromLoop`       | `value: boolean`                                                                            | untagged | `init()`, `setStartFromLoop()`                                                      |
| `voice:setKeytrackLoopAmount`  | `value` (0..1)                                                                              | untagged | `init()`, `setKeytrackLoopAmount()`                                                 |
| `voice:setPanDriftEnabled`     | `value: boolean`                                                                            | untagged | `setPanDriftEnabled()`                                                              |
| `voice:setPlaybackDirection`   | `playbackDirection: 'forward' \| 'reverse'`                                                 | untagged | `setPlaybackDirection()`                                                            |
| `voice:setTimestretchMode`     | `value: 'off' \| 'period'`                                                                  | untagged | `init()`, `setTimestretchMode()`                                                    |
| `voice:setInterpolation`       | `value: 'linear' \| 'hermite' \| 'sinc'`                                                    | untagged | `init()` if set before it, `setInterpolation()`                                     |

The processor also handles `voice:start` (`triggerId`, `timestamp`, `midiNote`, `velocity`, `glideTime`, `glideFromNote`) and `voice:stop` (`timestamp`), tagged or not. Nothing on the main thread sends them; they stay because the engine tests start and stop voices with them (and read the first voice through the processor's `engine`/`voice` fields). `voice:start` gets its rate from the pool like a `pool:noteOn`.

## Processor → main

| type              | fields                                                                                                    | notes                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `flushed`         | `id`                                                                                                      | untagged acknowledgement of `flush`; all preceding port messages have been handled.            |
| `initialized`     | none                                                                                                      | untagged, once, from the constructor. The player then posts the settings marked above.         |
| `voice:loaded`    | `durationSeconds`, `time`                                                                                 | one per voice per `voice:setBuffer`. The player emits `sample:loaded` after the last one.      |
| `voice:started`   | `triggerId`, `midiNote`, `velocity`, `timestamp`, `glideTime`, `glideFromNote`                            | allocator picked this voice; posted before the engine starts, so it precedes its reports.      |
| `voice:retuned`   | `midiNote`, `velocity`, `timestamp`, `glideTime`, `fallback`                                              | legato retune, rate already set; `fallback` means a note-off returned to an earlier held note. |
| `voice:releasing` | none                                                                                                      |                                                                                                |
| `voice:ended`     | `triggerId`                                                                                               | the note finished, or a buffer swap dropped it. The player emits `voice:stopped`.              |
| `loop:enabled`    | `enabled`                                                                                                 | echo of `voice:setLoopEnabled`, once per voice; ignored (the player emits its own).            |
| `loop:range`      | `loopStart`, `loopEnd`, `triggerId`; playing: `loopMode`, `isInPitchLoop`; idle: `keytrackAmount`, `idle` | throttled; `idle` reports describe the next note and are dropped on the main thread.           |
| `trim:range`      | `startPoint`, `endPoint`, `inverted`, `triggerId`                                                         | throttled.                                                                                     |
| `voice:position`  | `position` (0..1), `triggerId`                                                                            | ~60 Hz, only while position tracking is on.                                                    |

## Pitch

- `VoicePool` holds the pitch offset and whether pitch is on. A played note's rate is `midiToPlaybackRate(midiNote + offset)` (reference note 60), or 1 with pitch off. It computes the rate of a started note and its glide origin, of legato and fallback retunes, and of a `voice:start`. With pitch off nothing glides between notes; a legato retune still passes its glide time, so the ramp to rate 1 that disabling started is not cut short.
- The glide origin is the last note applied, or the earlier held note a fallback returned to; 60 before the first note. `glideFromNote` in `voice:started` is that played note, `null` without glide; `VoiceEffects` adds its offset for the AM LFO.
- A setting change retunes at the processor's `currentTime` when handled: a new offset moves voices that have a note with a 0.01 s time constant (0 while pitch is off); pitch off sends every voice to rate 1 with 0.1/3; pitch on retunes voices that have a note with 0.01/3.
- `VoiceEffects` keeps its own copy of the offset only for its main-thread effects (feedback, AM LFO).

## Ordering the code relies on

- The port is FIFO. `voice:setBuffer` is posted before any `pool:noteOn` meant for it, so the note never reaches a voice without its audio; `play()` checks only that a buffer was posted, not that `voice:loaded` came back.
- `pool:allNotesOff` goes out before `voice:setBuffer`. Notes scheduled on the old buffer go with it.
- `voice:setPitchPeriods` follows `voice:setBuffer`: a new buffer clears the periods.
- Settings posted before `initialized` arrive are queued and applied in order; `initialized` only tells the player its voices are on defaults and need the player's envelopes, glides and position tracking.
- `voice:started` is posted before the voice's first `loop:range`/`trim:range`, so the main thread knows the note's `triggerId` before ranges for it arrive.

### Offline delivery

`OfflineAudioContext.suspend(0)` pauses rendering, but posting a message and immediately calling `resume()` does not order its delivery before rendering. Rendering can finish before the processor receives the note ([#187](https://github.com/KristinnRoach/web-audio/issues/187)).

After setup and scheduling, await `player.flushMessages()` before resuming. It posts `flush` on the same FIFO port; the processor replies `flushed` after handling earlier messages. Scheduled notes have entered the queue, but still start only when due. This is independent of the constructor's `initialized` report, which does not acknowledge later commands.

`flushMessages()` requires completed `init()`. Calls have distinct ids; disposal rejects outstanding calls. It confirms only preceding port messages, not AudioParam automation, messages posted later, or main-thread AM/feedback and bus reactions to reports during rendering. Full offline effects timing remains separate work after migration step 6.

## Voice state on the main thread

`SamplePlayer.#receive` keeps one record per voice, `{ state, midiNote, triggerId, effects }`, and emits on the player's own bus. Voice reports go out with the voice's id as `senderId` and as `voiceId`. `sample:loaded` is the exception: its `senderId` is the last voice's and it has no `voiceId`. A pitch offset change reaches held notes through `effects.setPitchOffset(offset, midiNote)`.

| report                                       | record                                                                                                              | upstream                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `voice:started`                              | a voice not `AVAILABLE` was stolen: `voice:stopped` for its old note first; then `PLAYING`, `midiNote`, `triggerId` | bus `noteOn`, `voice:started` (`voiceId`, `midiNote`, `velocity`, `timestamp`, `glideTime`), then `effects.followNote` |
| `voice:retuned`                              | only while `PLAYING`: `midiNote`                                                                                    | `effects.followNote`, bus follows; not passed on                                                                       |
| `voice:releasing`                            | only while `PLAYING`: `RELEASING`                                                                                   | `voice:releasing` (`voiceId`, `midiNote`)                                                                              |
| `voice:ended`                                | only for the current `triggerId`: `AVAILABLE`, `midiNote` null                                                      | `voice:stopped` (`voiceId`, `midiNote`)                                                                                |
| `loop:range`, `trim:range`, `voice:position` | dropped when `idle`, when the voice is `AVAILABLE` or for another `triggerId`                                       | same type, `triggerId` replaced by `voiceId` and `midiNote`                                                            |

`dispose()` emits `voice:stopped` for every voice still sounding.

## Main-thread structure

| piece          | holds                                                                                                    | does                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SamplePlayer` | the worklet, `voices[]` records, the buffer, legato and pitch settings, envelope configs, other settings | `init`, `loadAudio`, `dispose`; `play`, `release`, `releaseAll`; `#post` to and `#receive` from the processor; sets the worklet's AudioParams                             |
| `VoiceEffects` | one voice's chain (source → am, hpf, feedback, lpf in configured order → out), its pitch offset          | built and wired in its constructor (outputs `2i` and `2i + 1`); `connect`, `followNote`, `getGainStages`, `dispose`; filter cutoffs, AM depth, waveform and octave offset |

## Usage

```ts
// SamplePlayer.init(), shortened
const worklet = createSampleWorklet(context, polyphony);
const voices = Array.from({ length: polyphony }, (_, voiceIndex) => ({
  state: VoiceState.AVAILABLE,
  midiNote: null,
  triggerId: 0,
  effects: new VoiceEffects(context, worklet, voiceIndex),
}));
// e.g. voice:started → voices[3] PLAYING, effects follow, voice:started emitted upstream
worklet.port.onmessage = ({ data }) => this.#receive(data);

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
