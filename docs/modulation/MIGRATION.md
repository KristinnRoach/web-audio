# Modulation migration

Steps from the current code to the [modulation model](MODEL.md). Written on 2026-11-10 against [`480b47d6`](https://github.com/KristinnRoach/web-audio/commit/480b47d6). Check the code again before starting a step, since it may have moved on.

Main-thread modulation, such as envelopes, LFOs and Web Audio filters, moves only when it moves to the audio thread, or once we decide to keep it on the main thread. Until then, leave it alone.

## Steps

1. **Exponential keytracking — done.** `getKeytrackedValue(value, midiNote, { rootNote, depth, mapping })` in `engine/keytrack.js` is the only export; defaults are root 60, depth 1, exponential. Loop keytrack uses it and tracks `soundingMidiNote`, so its endpoints sound as before; amounts between 0 and 1 now track exponentially.
   - Temporary: the engine receives playback rate, not MIDI notes, so the loop converts the sounding rate to a fractional note at the call site and the helper takes the root back off. This goes away once the engine gets `soundingMidiNote` directly. The `midiNote` source arrives with routes.
   - Temporary: stretch flips the depth sign; rounding and the one-sample minimum stay in the loop calculation.
   - Public loop controls keep `amount` in their names for compatibility; the keytrack API uses `depth`.
2. **Engine-side randomness as sources.** Loop drift becomes the `cycle` source, routed to loop length and pan.
3. **Routes on the audio thread.** Add the route list when envelopes and LFOs move to the audio thread ([roadmap 6D](../SAMPLE_PLAYER_ROADMAP.md)). Move each main-thread modulator onto routes as it arrives. That covers envelopes, LFOs and their note sync, envelope rate sync, filter keytrack, AM rate and feedback pitch.
4. **Remove main-thread copies.** Delete main-thread copies of engine formulas once the engine owns their consumers.
