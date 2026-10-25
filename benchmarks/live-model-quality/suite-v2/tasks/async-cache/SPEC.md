# Task 1: repair a two-module asynchronous user cache

Implement the existing APIs in `cache.mjs` and `client.mjs`; no extra exports, imports other than the existing local import, dependencies, I/O, timers, dynamic execution or delegation. The parent owns independent tests. Only these two files may change.

`createAsyncCache({ load, now, ttlMs })` returns exactly the public operations `get(key)` and `invalidate(key)`:
- Validate at construction: load/now must be functions; ttlMs must be finite and >=0. Invalid configuration throws TypeError.
- Keys must be non-empty strings. Invalid keys throw TypeError synchronously before calling load. Keys are otherwise opaque and are not normalized by this core.
- get always returns a Promise for valid keys. A synchronous load exception becomes a rejected Promise, not a synchronous exception.
- Concurrent gets of the same pending key share one underlying load. Different keys are independent. Promise object identity is not prescribed.
- A successful value is cached until `now() >= resolvedAt + ttlMs`; TTL begins when the load resolves, not when requested. At the exact boundary load again. ttlMs0 keeps single-flight for pending requests but never reuses a settled value.
- Rejected loads are not cached; a later get may load again.
- invalidate removes both a cached value and pending admission for that key. Existing callers still receive their original result/rejection; a subsequent get starts a new load. An old load must never overwrite a newer value, or erase a newer pending entry when it rejects.
- Values are opaque and may be undefined. Do not treat undefined as a cache miss. Do not add automatic retry or background work.

`createUserClient({ fetchUser, now, ttlMs })` uses that cache and returns `getUser(id)` and `invalidateUser(id)`. Each operation accepts a string with non-empty trimmed content, uses the trimmed ID as the cache/load key, and rejects invalid IDs synchronously with TypeError. The injected clock is deterministic and returns finite timestamps; do not read a real clock.

This is invented code/data. Report only changes and honest verification status; do not claim parent-held tests were run.
