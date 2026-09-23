---
'@kidlib/web-audio': patch
---

Breaking envelope API renames since 0.5.0. There is no compatibility layer, and configs saved in the old shape have to be migrated by the caller.

| 0.5.0                                                         | Now                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `getEnvelopeConfig(id)`                                       | `getEnvelope(id)`                                                  |
| `applyEnvelopeConfig(id, config)`                             | `updateEnvelope(id, patch)`: shallow merge into the current config |
| `setEnvelopeSync(id, sync)`                                   | `updateEnvelope(id, { playbackRateSync: sync })`                   |
| `resetEnvelopes()`                                            | `resetEnvelope()` (with no id it resets all)                       |
| `availableEnvelopeIds`                                        | `envelopeIds`                                                      |
| `EnvelopeConfig.envelope`                                     | `EnvelopeConfig.shape`                                             |
| `EnvelopeShape.sustain` / `.release`                          | `EnvelopeShape.sustainPoint` / `.releasePoint`                     |
| `SampleEnvelopeId` `'amp-env'`, `'pitch-env'`, `'filter-env'` | `'amp'`, `'pitch'`, `'filter'`                                     |
| `envelope:changed` `{ envelopeId, settings }`                 | `envelope:changed` `{ id, config }`                                |

- `EnvelopeConfig` now carries `playbackRateSync`, so `getEnvelope` returns it, `envelope:changed` includes it and `resetEnvelope` turns it off.
- `updateEnvelope` does a shallow merge, so a `shape` in the patch replaces the whole shape.
