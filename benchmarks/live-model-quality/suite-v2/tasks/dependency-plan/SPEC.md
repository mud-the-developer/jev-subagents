# Task 3: deterministic dependency planning and rendering across two modules

Repair `planner.mjs` and `summary.mjs` only. Preserve named exports; no extra exports, dependencies, I/O, dynamic execution, timers or delegation. Use only the existing local import. Parent-held tests are not granted to the worker.

`planTasks(tasks)`:
- Accept an array of non-array data objects owning `id` and `after`. IDs match `/^[a-z][a-z0-9_-]{0,31}$/` exactly; after is an array of IDs. Empty input is valid. Additional row metadata may be ignored, not mutated.
- Reject malformed arrays/rows/IDs, duplicate task IDs, duplicate dependency IDs, unknown dependencies and self-dependencies with TypeError.
- For a valid DAG return `{ order, layers }`. A layer is the complete set of currently ready tasks, sorted by JavaScript string/ASCII order, BEFORE removing that set and discovering the next layer. order is exactly layers.flat(). This is not a one-at-a-time priority-queue ordering.
- IDs and dependency order in the caller's input must never be changed; frozen input must work. Return fresh arrays, not aliases to dependency arrays.
- Cycles (including a cycle plus unrelated ready nodes) reject with RangeError and never return a partial plan. Do not loop forever or silently drop blocked nodes.

`renderTaskPlan(tasks)` delegates planning/validation to planTasks and returns exact text:
- Empty tasks -> `(empty)`.
- Otherwise one line per layer: `layer0: a, b` then `layer1: c`, joined with `\n`, without a final newline. The layer index is zero-based and IDs use the planner's sorted order.
- Propagate the planner's TypeError/RangeError rather than forging a summary.

Only synthetic data objects are in scope; no proxy/accessor behavior is required. Do not claim tests passed if you did not run them.
