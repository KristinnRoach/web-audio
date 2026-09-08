---
"@kidlib/web-audio": patch
---

- Improve sampler timing and release behavior.
- Notes scheduled with a future timestamp now honor the future start time correctly.
- Looping voices stop reliably after retriggers or all-notes-off.
- Looping-envelope releases produce audible clicks less often.
