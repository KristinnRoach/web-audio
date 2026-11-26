# Glossary

Plain-English definitions for key terms in this project. Use these exact words in code, comments, and replies.

## Sample player processor

Internal to the worklet (`src/worklets/processors/play/`). The public API is `SamplePlayer`.

- **Processor**: The audio-thread half of one `SamplePlayer`. It owns all of that player's voices and one shared set of AudioParams.
  - _Not to confuse with_: **node**, the main-thread side (`SamplePlayer` and its `AudioWorkletNode`) that sends it messages and receives its reports.
- **Voice**: One slot that can play one note at a time. In code it has three parts: the **engine** (`VoiceEngine`, renders audio), the **pool voice** (`PoolVoice`, tracks state for the allocator) and its **voice index** (the `voice` field on messages, which also picks output `2i` and `2i + 1`).
  - _Not to confuse with_: `this.voices`, the processor's list of `{ engine, voice, post }` records.
- **Pool**: `VoicePool`. Queues note events until they are due, asks the **allocator** which voice to use, and holds the pitch settings (pitch offset, pitch on/off) shared by every voice.
- **Allocator**: `VoiceAllocator`. Picks which voice a note event starts, steals, retunes or releases. Default: a free voice, else the oldest releasing voice, else the oldest playing one.
- **Pool command vs voice command**: `pool:*` messages are player-wide and go through the pool (`noteOn`, `noteOff`, legato, pitch). `voice:*` messages set up or control one voice, or all voices when no `voice` index is given.
- **Trigger**: One start of a voice, identified by `triggerId`. Reports such as `voice:started` and `voice:ended` carry it so the node can match them to the note it asked for.
  - _Not to confuse with_: **note**, the MIDI note and velocity that a trigger plays.
- **Release vs stop vs ended**: **Release** starts the envelope's fade-out; the voice keeps sounding. **Stop** cuts the sound at its timestamp, and the allocator treats the voice as free right away. **Ended** (`voice:ended`) is the report that a voice has gone silent and is free again.
- **Note rate vs `playbackRate` param**: The **note rate** is the speed that makes the sample sound at the played note (from MIDI note + pitch offset; 1 with pitch off). The `playbackRate` AudioParam multiplies it, and `detune` adds cents on top.
  - _Avoid_: calling the note rate "playbackRate" in replies, even though the note object uses that key.
- **Trim vs loop**: **Trim** (`trimStart`/`trimEnd`) sets which part of the sample can play at all. **Loop** (`loopStart`/`loopEnd`) sets the part that repeats while the note is held. Both are in seconds.
- **Flush**: A `flush` message the processor answers with `flushed` once every earlier message is handled. Used to wait until queued commands have reached the audio thread.
