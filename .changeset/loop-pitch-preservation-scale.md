---
'@kidlib/web-audio': patch
---

`MacroParam.getValue()` is replaced by the `value` getter. Loop pitch preservation now follows the longest period in the loop-end scale (it was fixed at C0), and amplitude compensation only applies to loops shorter than a C2 period.
