# Task 2: complete a two-module authorization-aware record gateway

Repair `policy.mjs` and `gateway.mjs` only. Keep the named exports; no new dependencies, I/O, network, dynamic execution or delegation. This is a pure synthetic adapter, not a real HTTP server/security certificate. Inputs are data objects; inherited credential/record fields are explicitly invalid, while proxy/accessor side effects are outside this task.

Policy exports `isValidUser(user)` and `canAccess(user, action, record)`:
- A valid ID matches `/^[a-z][a-z0-9_-]{0,31}$/` exactly. A valid user is a non-array object with OWN `id` and `role`, valid ID and role exactly `member` or `admin`. Null/prototype-inherited/malformed credentials deny rather than throw.
- A valid record is a non-array object owning id, ownerId, title and archived: valid IDs, string title and boolean archived. Ignore additional record fields internally, but do not disclose them.
- Actions are exactly read/update/delete; every unknown or malformed case returns false without throwing.
- Members may read/update only their own records and may never delete. Admins may read/update any valid record, but may delete only when archived is true.

Gateway exports asynchronous `handle(request, repo)` and uses the policy module. Request fields are method, user, id, and optional body. Order validation before repository access: unknown method ->405; invalid user ->401; invalid ID ->400; invalid PATCH body ->400. Malformed/null request ->400. Responses are exactly `{ status, body }`, using body null for every error and DELETE success.
- Methods are GET/PATCH/DELETE, case-sensitive. `repo.findById(id)` is awaited only after initial validation. Missing/null record ->404. A record whose id differs from requested ID ->403. Policy denial ->403; no mutation callback may run.
- GET requires read permission and returns200 with only `{ id, title }`, never ownerId/archived/extra secret fields.
- PATCH requires update permission. Body must be a non-array object with exactly one own enumerable key `title`, a string whose trimmed length is1..80. Validate before lookup, then call/await `repo.updateTitle(id, trimmedTitle)` exactly once. Return200 with `{ id, title: trimmedTitle }`; do not trust or disclose the callback return object.
- DELETE requires delete permission, then call/await `repo.delete(id)` once and return204/body null.
- Repository rejections must propagate as rejections; do not forge successful responses. Do not mutate the request, user, body or returned record. Parent tests use frozen inputs and callback spies.

Only the two approved module files may change. Parent-held tests are not available to the worker. Report verification honestly.
