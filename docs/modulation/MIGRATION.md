# Modulation migration

Steps from the current code to the [modulation model](MODEL.md). Written on 2026-11-10 against [`480b47d6`](https://github.com/KristinnRoach/web-audio/commit/480b47d6). Check the code again before starting a step, since it may have moved on.

Main-thread modulation, such as envelopes, LFOs and Web Audio filters, moves only when it moves to the audio thread, or once we decide to keep it on the main thread. Until then, leave it alone.

## Steps

1. **Exponential keytracking.** Add `getKeytrackedValue` to `keytrack.js` and move loop keytrack onto it. The helper takes a MIDI note and options for root note, depth and mapping (exponential or linear). The loop worklet converts its playback rate to a fractional MIDI note at the call site. A separate `midiNote` source remains to be added when routes are introduced. Loop length tracks the `soundingMidiNote` source (the note plus pitch modulation), so its endpoints sound as before. Amounts between 0 and 1 now track exponentially.
2. **Engine-side randomness as sources.** Loop drift becomes the `cycle` source, routed to loop length and pan.
3. **Routes on the audio thread.** Add the route list when envelopes and LFOs move to the audio thread ([roadmap 6D](../SAMPLE_PLAYER_ROADMAP.md)). Move each main-thread modulator onto routes as it arrives. That covers envelopes, LFOs and their note sync, envelope rate sync, filter keytrack, AM rate and feedback pitch.
4. **Remove main-thread copies.** Delete main-thread copies of engine formulas once the engine owns their consumers.
