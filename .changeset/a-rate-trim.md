---
'@kidlib/web-audio': minor
---

Trim points follow the same rules as loop points:

- The `trimStart` and `trimEnd` worklet AudioParams are a-rate and resolve together with the loop points. Moving trim and a pitch loop at once no longer plays the loop clamped to the old trim for the rest of the block, and a note scheduled on a trim change starts at the new trim start.
- A trim range no longer than the longest pitch-quantization period is quantized to the scale, like a loop, also with looping off. Longer ranges still snap inward to zero crossings. Setting trim and a pitch loop to the same points now keeps the loop's pitch.
- Trim points are no longer rounded to whole samples.
