# Glossary

Plain-English definitions for key terms in this project. Use these exact words in code, comments, and replies.

## Sample player processor

Internal to the worklet (`src/worklets/processors/play/`). The public API is `SamplePlayer`.

- **Processor**: The host-facing audio unit for one player. Handles commands and parameters from the runtime host, advances the pool, and drives block rendering for all voices. _(Here: `SamplePlayerProcessor`.)_
  - _Not to confuse with_: **node**, the main-thread side (`SamplePlayer` / `AudioWorkletNode`) that sends it messages and receives its reports.
- **Voice**: Plays one note at a time. In code it has three parts: the **voice engine** (`VoiceEngine`, renders audio), the **pool voice** (`PoolVoice`, tracks state for the allocator) and its **voice index** (the `voice` field on messages, which also picks output `2i` and `2i + 1`).
  - _Not to confuse with_: **slot**, the processor's `{ engine, voice, post }` record for one voice (`this.slots`).
- **Voice engine**: One voice's host-independent playback state and DSP renderer (`VoiceEngine`).
  - _Avoid_: bare "engine" when referring to one voice (the `engine/` folder also holds the pool and allocator).
- **Pool**: `VoicePool`. Queues note events until they are due, asks the **allocator** which voice to use, and holds the pitch settings (pitch offset, pitch on/off) shared by every voice.
- **Allocator**: `VoiceAllocator`. Picks which voice a note event starts, steals, retunes or releases. Default: a free voice, else the oldest releasing voice, else the oldest playing one.
- **Pool command vs voice command**: `pool:*` messages are player-wide and go through the pool (`noteOn`, `noteOff`, legato, pitch). `voice:*` messages set up or control one voice, or all voices when no `voice` index is given.
- **Trigger**: One start of a voice, identified by `triggerId`. Reports such as `voice:started` and `voice:ended` carry it so the node can match them to the note it asked for.
  - _Not to confuse with_: **note**, the MIDI note and velocity that a trigger plays.
- **Release vs stop vs ended**: **Release** starts the envelope's fade-out; the voice keeps sounding. **Stop** cuts the sound at its timestamp, and the allocator treats the voice as free right away. **Ended** (`voice:ended`) is the report that a voice has gone silent and is free again.
- **Note rate vs `playbackRate` param**: The **note rate** is the speed that makes the sample sound at the played note (from MIDI note + pitch offset; 1 with pitch off). The `playbackRate` AudioParam multiplies it, and `detune` adds cents on top.
  - _Avoid_: "playbackRate" for the note rate; the note object's key is `noteRate`.
- **Trim vs loop**: **Trim** (`trimStart`/`trimEnd`) sets which part of the sample can play at all. **Loop** (`loopStart`/`loopEnd`) sets the part that repeats while the note is held. Both are in seconds.
- **Playback direction**: `'forward'` or `'reverse'`, set with `voice:setPlaybackDirection` and stored as the voice engine's `playbackDirection`.
  - _Avoid_: `reversePlayback`.
- **Flush**: A `flush` message the processor answers with `flushed` once every earlier message is handled. Used to wait until queued commands have reached the audio thread.

## Loops

How the voice engine turns `loopStart`/`loopEnd` into what it plays (`engine/loop-*.js`, `voice-engine.js`).

- **Requested loop vs loop window**: The **requested loop** is the `loopStart`/`loopEnd` params as sent. The **loop window** (`LoopWindow`) is what actually plays, in source samples, after trim, quantize, glide, keytrack and drift. The `loop:range` report carries the loop window.
  - _Avoid_: "resolved range" or "loop range"; `loop:range` is only the report's name.
- **Pitch loop vs time loop**: Decided once from the requested loop's length. A **pitch loop** is at or below the pitch cutoff, so it repeats fast enough to sound as a tone; it can be quantized and glided. A **time loop** is longer and repeats a passage; it can be keytracked.
  - _Avoid_: "audio-rate loop" or "short loop" for a pitch loop.
- **Pitch cutoff**: The longest loop that counts as a pitch loop: the longest loop quantize period, else about 31 ms (one cycle of C1). In code: `pitchCutoff`.
  - _Avoid_: "pitch preservation threshold", "short-loop cutoff".
- **Loop quantize periods**: The allowed pitch-loop lengths, sent with `voice:setLoopQuantizePeriods`. A pitch loop snaps to the nearest one.
  - _Avoid_: "scale" for this list.
- **Loop length glide vs loop position glide**: How quickly a pitch loop moves to a new length (`setLoopLengthGlide`) or a new start (`setLoopPositionGlide`). Both are time constants in seconds; 0 steps at once.
- **Keytrack loop**: Controls how a time loop's length follows the played note (`keytrackLoopAmount`, 0–1). With resampling, 0 keeps the length fixed in samples and 1 keeps the duration fixed in seconds across notes. With period stretching active, 0 keeps the duration fixed in seconds and 1 makes the duration shorter at higher notes and longer at lower notes.
- **Loop drift**: Small random changes to the loop end, rolled again every few passes so repeats sound less mechanical (`loopDurationDriftAmount`).
  - _Not to confuse with_: **pan drift**, the same idea applied to stereo position.
- **Loop mode**: How the playhead passes a loop edge. **Forward** jumps to the other edge (**wrap**). **Reverse** (loop start after loop end) turns around once, then wraps. **Ping-pong** turns around at every edge (**turn**). Reported as `loopMode`; set by loop point order and `voice:setLoopPingPong`.
  - _Not to confuse with_: **playback direction**, which sets which way the playhead approaches the loop. Both can be `'reverse'` and they combine, so say "reverse loop" or "reverse playback", never bare "reverse".
  - _Avoid_: "backward" for the loop mode.
- **Loop crossfade vs move fade**: A **loop crossfade** smooths a wrap or turn by fading out an extra read head that keeps reading past the edge. A **move fade** smooths a pitch loop jumping to a new start; moves that arrive during it wait, and the playhead follows the **held loop window** (`heldLoopWindow`).
- **Playhead carry**: When a pitch loop's window moves, the playhead moves with it so the tone keeps going. Time loops don't carry; the playhead stays put.
