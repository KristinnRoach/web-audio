---
'@kidlib/web-audio': patch
---

Make the `trimStart` and `trimEnd` worklet AudioParams a-rate, resolved together with the loop points. Moving trim and a pitch loop at once no longer plays the loop clamped to the old trim for the rest of the block, and a note scheduled on a trim change starts at the new trim start.
