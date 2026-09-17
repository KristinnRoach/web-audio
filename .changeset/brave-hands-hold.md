---
"@kidlib/web-audio": patch
---

A held note now follows edits to its sustain point's value. `applySettings` forwards the new value to a run that is already parked on sustain: the parameter glides to it and note-off releases from it. The hold is an absence of scheduled events rather than an event, so it can be moved in place with no seam to wait for. Runs that have not reached their sustain point yet, looping runs, and runs playing a shape mapped from the stored settings are unchanged and pick the edit up on the next trigger.
