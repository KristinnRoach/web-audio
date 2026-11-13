---
'@kidlib/web-audio': patch
---

Preserve source audio in Brave by copying channel data before validation, analysis, preprocessing, recording trims, and voice loading. Reuse channel snapshots during normalization and compression so repeated reads do not change the source or skew processing levels.
