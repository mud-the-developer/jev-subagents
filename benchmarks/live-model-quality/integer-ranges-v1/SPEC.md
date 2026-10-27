# Synthetic live-model quality task

Fix the existing exported `mergeClosedIntegerRanges(ranges)` function in `ranges.mjs`. Preserve its name and synchronous API; no other exports, imports, dependencies, I/O or dynamic execution.

Contract:
- Input is an array of pairs `[start, end]` representing inclusive integer intervals. The empty array is valid.
- Each pair must be an actual array with exactly two finite safe-integer endpoints, and `start <= end`. Reject every other input with `TypeError`; error-message wording is not prescribed.
- Return new pairs sorted by increasing start. Merge all overlapping or integer-adjacent ranges; contained ranges must never shrink an earlier end.
- Preserve every input array/pair: do not reorder or edit the caller's objects, and do not return aliases to those pairs.
- Support negative endpoints and both safe-integer boundaries.

Examples:
- `[[4, 6], [1, 2], [3, 3]]` becomes `[[1, 6]]`.
- `[[1, 10], [2, 3], [12, 12]]` becomes `[[1, 10], [12, 12]]`.
- `[]` becomes `[]`.

Only `ranges.mjs` may be changed. This is invented code and data, not a user repository or real customer input. The parent will independently review the diff and run held-out assertions derived only from this contract. Do not claim a test passed unless you actually ran it. Do not delegate or request another model.
