# Glossary

Plain-English definitions for key terms in this project. Use these exact words in code, comments, and replies.

## Sample player processor

Internal to the worklet (`src/worklets/processors/play/`). The public API is `SamplePlayer`.

- **Processor**: The host-facing audio unit for one player. Handles commands and parameters from the runtime host, advances the pool, and drives block rendering for all voices. _(Here: `SamplePlayerProcessor`.)_
  - _Not to confuse with_: **node**, the main-thread side (`SamplePlayer` / `AudioWorkletNode`) that sends it messages and receives its reports.
- **Voice**: Plays one note at a time (`SamplePlayerVoice`). Holds one voice's host-independent playback state and DSP rendering.
  - _Not to confuse with_: **voice slot** (`VoiceSlot`), which tracks allocator state around a voice, or the **voice index** (the `voice` field on messages, which also picks output `2i` and `2i + 1`).
  - _Avoid_: "voice engine" or bare "engine" for one voice.
- **Voice slot**: `VoiceSlot`. One seat in the pool (`this.voiceSlots` on the processor). Tracks allocator state (`AVAILABLE` / `PLAYING` / `RELEASING`, `midiNote`, `triggerTimestamp`) and holds its `voice` (`SamplePlayerVoice`) and `postMessage` callback.
  - _Avoid_: bare "slot" outside `VoicePool` (use `voiceSlot` / `voiceSlots` for clarity).
- **Pool**: `VoicePool`. Queues note events until they are due, asks the **allocator** which **voice slot** to use, and holds the pitch settings (pitch offset, pitch on/off) shared by every voice.
- **Allocator**: `VoiceAllocator`. Picks which **voice slot** (`voiceSlots`) a note event starts, steals, retunes or releases. Default: a free slot, else the oldest releasing slot, else the oldest playing one.
- **Pool command vs voice command**: `pool:*` messages are player-wide and go through the pool (`noteOn`, `noteOff`, legato, pitch). `voice:*` messages set up or control one voice, or all voices when no `voice` index is given.
- **Trigger**: One start of a voice, identified by `triggerId`. Reports such as `voice:started` and `voice:ended` carry it so the node can match them to the note it asked for.
  - _Not to confuse with_: **note**, the MIDI note and velocity that a trigger plays.
- **Release vs stop vs ended**: **Release** starts the envelope's fade-out; the voice keeps sounding. **Stop** cuts the sound at its timestamp, and the allocator treats the voice as free right away. **Ended** (`voice:ended`) is the report that a voice has gone silent and is free again.
- **Note rate vs `playbackRate` param**: The **note rate** is the speed that makes the sample sound at the played note (from MIDI note + pitch offset; 1 with pitch off). The `playbackRate` AudioParam multiplies it, and `detune` adds cents on top.
  - _Avoid_: "playbackRate" for the note rate; the note object's key is `noteRate`.
- **Trim vs loop**: **Trim** (`trimStart`/`trimEnd`) sets which part of the sample can play at all. **Loop** (`loopStart`/`loopEnd`) sets the part that repeats while the note is held. Both are in seconds.
- **Playback direction**: `'forward'` or `'reverse'`, set with `voice:setPlaybackDirection` and stored as the voice's `playbackDirection`.
  - _Avoid_: `reversePlayback`.
- **Flush**: A `flush` message the processor answers with `flushed` once every earlier message is handled. Used to wait until queued commands have reached the audio thread.

## Loops

How `SamplePlayerVoice` turns `loopStart`/`loopEnd` into what it plays (`engine/loop-*.js`, `sample-player-voice.js`).

- **Requested loop vs loop window**: The **requested loop** is the `loopStart`/`loopEnd` params as sent. The **loop window** (`LoopWindow`) is what actually plays, in source samples, after trim, quantize, glide, keytrack and drift. The `loop:range` report carries the window playing now (the latched loop window once in the loop).
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
- **Latched loop window**: The loop window a loop pass plays (the pass scheduler's `pass` while `isLoopPass`). Copied from the resolved window when the playhead reaches the loop and at every wrap or turn. Moves, loop mode and longer loops are heard at the next edge; a shorter loop is heard at once (shrink only).
- **Loop crossfade**: The grain fade at a wrap or turn. Lasts a fraction of the pass, or `LOOP_MOVE_CROSSFADE_SECONDS` of output time when the loop moves to a new start.

## Playback

How a voice reads the source (`engine/grain-pool.js`, `engine/pass-scheduler.js`).

- **Grain**: One read of the source: a position, a direction and a fade. The **playhead** is the current grain; at an edge it hands off to an outgoing grain that reads on past the edge and fades out.
  - _Avoid_: "read window" or "`Window`" for a grain. A **read head** is any grain (or the stretcher's fade head) mixed in one sample.
- **Grain pool**: `GrainPool`. The playhead plus up to `MAX_OUTGOING_GRAINS` outgoing grains, mixed newest inside oldest.
- **Pass**: One stretch of playback that ends at an edge in its direction of travel. A note's first pass runs from the note start toward the trim end; each **loop pass** plays the latched loop window.
- **Pass scheduler**: `PassScheduler`. Decides what happens at each pass's edge: wrap or turn into the next loop pass, play on to the trim end (loop turned off), or stop at the note's last edge. Every edge that moves or stops the playhead uses the same grain fade.
- **Hop scheduler**: Starts a grain every hop, at a **time position** that moves independently of the read rate. Grain timestretch (`GrainStretcher`, timestretch mode `'grain'`) is one: the time position moves at original speed.
  - _Not to confuse with_: **pass scheduler**, which acts at pass edges.
- **Shrink only**: An edit can pull the current pass's end in, never push it out. Trim pulls a first pass's end in; a shorter resolved loop shortens a loop pass. If the playhead is already past the new end, the pass ends now.
