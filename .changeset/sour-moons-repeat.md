---
"@kidlib/web-audio": patch
---

Fix the voice signal chain wiring a dry bypass around HarmonicFeedback, doubling the voice output (+6 dB) and clipping even with the feedback amount at zero.
