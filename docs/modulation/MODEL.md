# Modulation model

The planned model uses one routing system for keytracking, velocity, envelopes, LFOs and randomness. Currently implemented: the MIDI-note keytracking helper and its use for loop duration. Source signals and the route list described below are future work.

## The rule

Each modulatable parameter is a **target**, resolved per voice on the audio thread:

```text
result = fromDomain(toDomain(value) + Σ depth · sourceOffset)
```

Each route converts its source into an offset appropriate for the target mapping. Clamping happens once, at the end.

## Domains

A target's mapping defines how modulation depth changes its value.

- **Exponential:** frequency, duration, playback speed, length. Values are scaled multiplicatively; the formula uses base-2 logarithms internally. A change of 1 in this domain doubles a value. For musical pitch, that is one octave.
- **Linear:** MIDI pitch, gain, pan, mix, position. Values receive an additive offset; depth uses the target's units.

## Sources

Per-voice source signals (before route conversion):

| Source             | Range                  | Notes                                                                |
| ------------------ | ---------------------- | -------------------------------------------------------------------- |
| `midiNote`         | MIDI note (fractional) | The played note, including glide. Pitch modulation does not move it. |
| `soundingMidiNote` | MIDI note (fractional) | The sounding pitch: `midiNote` plus all pitch modulation.            |
| `velocity`         | 0..1                   |                                                                      |
| `env`              | 0..1 or -1..1          | Several per voice                                                    |
| `lfo`              | -1..1                  | Per voice, or shared by the player                                   |
| `random`           | -1..1                  | Rolled once per note                                                 |
| `cycle`            | -1..1                  | Rolled on each loop cycle                                            |

## Routes

A target owns its value, mapping, limits and rounding. A route owns its source, target and depth. Routes from `midiNote` or `soundingMidiNote` also specify `rootNote`.

```js
const targets = {
  cutoff: { value: 1000, mapping: 'exponential' },
  pan: { value: 0, mapping: 'linear' },
};

const routes = [
  { source: 'midiNote', target: 'cutoff', rootNote: 60, depth: 1 },
  { source: 'midiNote', target: 'pan', rootNote: 60, depth: 0.025 },
  { source: 'velocity', target: 'cutoff', depth: 2 },
];
```

Normalized sources such as velocity and envelopes contribute `sourceValue * depth` in the target's domain. MIDI-note sources first subtract the route's root note and, for exponential targets, divide by 12. Contributions are summed in that domain before converting back and clamping.

A voice holds a fixed, preallocated list of routes. The main thread sends target values and route settings; a note-on sends the note and velocity.

`soundingMidiNote` is the resolved pitch target in MIDI-note units. It starts from `midiNote` and adds pitch modulation. Targets that read it resolve afterwards, and nothing that reads `soundingMidiNote` routes back into it.

## Keytracking

Keytracking routes the played note (`midiNote`) or sounding pitch (`soundingMidiNote`) to a target. Both use MIDI notes, including fractional notes for glide and pitch modulation. The route supplies root note and depth; the target supplies mapping. For exponential keytracking, the route offset is `(midiNote - rootNote) / 12`; for linear keytracking it is `midiNote - rootNote`. Raw MIDI-note numbers are never added directly as modulation offsets.

The engine exports only `getKeytrackedValue(value, midiNote, { rootNote, depth, mapping })` from `keytrack.js`. Pure math helpers remain private. Defaults are root note 60, depth 1 and exponential mapping.

- **Exponential:** `value * 2 ** ((midiNote - rootNote) / 12 * depth)`. Depth 1 doubles the value per 12 semitones, 0 leaves it fixed, and -1 inverts tracking.
- **Linear:** `value + (midiNote - rootNote) * depth`. Depth is target units per semitone, with 0 leaving the value fixed.

For example, a 1000 Hz cutoff with root note 60 and exponential depth 1 becomes 2000 Hz at MIDI note 72. Centered pan with the same root and linear depth 0.025 becomes 0.3 at note 72. Each target clamps and rounds its own result.

The loop worklet currently receives playback rate rather than MIDI notes. It converts the magnitude to a fractional MIDI note relative to the reference root, including pitch modulation. Stretch reverses depth; rounding and the one-sample minimum stay in the loop calculation. Options are reused to avoid per-sample allocation.

The name `depth` is shared with envelopes, but it is not a universal unit: envelope depth currently scales a normalized envelope in target units, while keytracking depth uses the mapping-specific units above. Envelope interpolation curves describe movement over time; keytracking mappings describe how a note changes a value.

Existing public loop controls still use `amount` in their names for compatibility; the new keytracking API uses `depth`.

Glide smooths `midiNote` itself, so every keytracked target glides together.

## Update rate

Each target declares its update rate. Targets that shape the waveform, such as pitch, amplitude modulation and audio-rate loop length, update every sample. The rest update every few dozen samples. `midiNote`, `velocity` and `random` are constant for a note apart from glide, so routing them costs little.

## Scope

Rules that belong to a target stay with that target. One example: a loop whose length sets the pitch ignores keytrack on its length. Another: loop length keytracks `soundingMidiNote`. Effects on the mixed output use player-level sources only.
