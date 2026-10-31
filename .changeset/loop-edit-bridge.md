---
'@kidlib/web-audio': patch
---

Fix clicks when loop points change during a held note with a loop-synced envelope. A catch-up envelope handover that would step now ramps over 5 ms to the new phase.
