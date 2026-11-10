# Modulation model

One rule for every user-facing parameter that can move while a note plays: keytracking, velocity, envelopes, LFOs and randomness all work the same way.

## The rule

Each modulatable parameter is a **target**, resolved per voice on the audio thread:

```text
value = fromDomain(base + Σ amount · source)
```

Clamping happens once, at the end.

## Domains

A target's domain decides what an amount means, so the same amount means the same thing on every target in that domain.

- **Log:** pitch, frequency, time, rate, length. Base and amounts are in octaves.
- **Linear:** gain, pan, mix, position. Amounts are a fraction of the target's range.

## Sources

Per-voice signals with a fixed range:

| Source     | Range                      | Notes                                                                |
| ---------- | -------------------------- | -------------------------------------------------------------------- |
| `key`      | octaves from the root note | The played note, including glide. Pitch modulation does not move it. |
| `velocity` | 0..1                       |                                                                      |
| `env`      | 0..1 or -1..1              | Several per voice                                                    |
| `lfo`      | -1..1                      | Per voice, or shared by the player                                   |
| `random`   | -1..1                      | Rolled once per note                                                 |
| `cycle`    | -1..1                      | Rolled on each loop cycle                                            |

## Routes

A route is `{ source, target, amount }`. A voice holds a fixed, preallocated list of them. The main thread sends base values and amounts; a note-on sends the note and velocity.

## Keytracking

Keytracking is the `key` source routed to a log-domain target. An amount of 1 makes the target follow the note fully, 0 leaves it fixed, and a negative amount inverts it. For example, cutoff with amount 1 moves an octave per octave played.

Glide smooths `key` itself, so every keytracked target glides together.

## Update rate

Each target declares its update rate. Targets that shape the waveform, such as pitch, amplitude modulation and audio-rate loop length, update every sample. The rest update every few dozen samples. `key`, `velocity` and `random` are constant for a note apart from glide, so routing them costs little.

## Scope

Rules that belong to a target stay with that target. One example: a loop whose length sets the pitch ignores keytrack on its length. Effects on the mixed output use player-level sources only.
