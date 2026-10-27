# Live configured-profile quality pilot: integer ranges v1

**Two real provider-backed jobs, one small invented repair task per profile, reported2026-10-25.** This is a transparent pilot with a negative control, not a statistically meaningful model ranking or general task-quality certificate. `low` versus `max` thinking is deliberately visible: the comparison is between configured profiles, not an isolated model-only effect.

## Observations

| Group | Contract groups | Seeded coverage oracle | SDK calls / cap | Reported elapsed | Observed USD estimate |
| --- | --- | --- | --- | --- | --- |
| Original buggy source, no model |4/12 |150/1000 |0 |not measured |0 |
| `worker`: `openai-codex/gpt-5.6-luna`, low |12/12 |1000/1000 |3/8 |10.898s |$0.00184248 |
| `worker_strong`: `openai-codex/gpt-6-astra`, max |12/12 |1000/1000 |5/8 |92.712s |$0.229134 |

Both workers changed only the declared source within their fixture; the spec/test hashes stayed unchanged, no extra fixture files appeared, cleanup was confirmed and no lock remained. Both explicitly said they had **not run tests**. Native results were `completed_unverified`/`needs_human_review`; the parent subsequently reviewed the pure functions and ran the independent assertions. That parent check is not live user task acceptance.

On this one task, both configurations reached the same observed correctness while the Luna/low run used fewer rounds and a lower reported elapsed/cost estimate. Do not infer that it is generally more capable, that Astra/max is unnecessary, or that these prices equal actual account charges.

## Controls and method

- The initial source, specification, common worker task summary, file-ID restrictions, one-worker count, SDK cap8 and180-second execution ceiling matched. Existing profiles/model/thinking were not changed, inherited from the parent or selected through JEV. JEV requests0 for both jobs.
- [Original source](buggy.mjs) is the **negative control**: the same tests expose8failed contract groups. Checked-in model outputs are [Luna/low](luna-low.mjs) and [Astra/max](astra-max.mjs), not parent-corrected solutions.
- [SPEC.md](SPEC.md) and [TASK.md](TASK.md) contain only invented non-sensitive requirements. The original [held-out test](held-out.test.mjs) is preserved byte-for-byte and was outside both workers' granted file IDs. Its12groups cover empty/overlapping/adjacent/contained/disjoint/negative/duplicate ranges, immutability/frozen input, fresh output, safe-integer boundaries and invalid inputs.
- A second independent oracle enumerates integer coverage for1000bounded random inputs in[-20,20] with seed`0x51a7c0de`, then reconstructs adjacent ranges. Inputs are frozen and output aliases are rejected. It does not replace the separate safe-integer boundary/validation checks. Its failure on the original source confirms that the oracle is discriminative, not a positive-only display.
- Both native jobs used fresh file scopes under the same workspace, with private test directories protected **at creation**. Original unsafe test files/ACLs were left unchanged; no cwd/model/provider fallback or permission repair was used. A prior refused file-scope preparation started0workers/models and is not counted as a failed model-quality trial or resumed grant.
- Runtime was existing non-admin native Windows, Bun1.4.3, worker SDK0.85.1, TypeBox1.3.7 and SDK-scoped undici8.12.2. No runtime/dependency upgrade, automatic retry, extra worker, shell tool or live model-based judge was added.

## Offline reproduction — zero new provider calls

From the source root, using an existing pinned Bun:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json benchmarks/live-model-quality/integer-ranges-v1/verify.mjs
```

The assertion-based verifier checks all five input/output hashes in [results.json](results.json), runs the **unchanged** held-out file against each variant in an owned temporary directory, and applies the same seeded oracle. The original must remain a negative control; both recorded solutions must satisfy their reported test counts. Child environments exclude credentials and ambient Node/Bun hooks. Only trusted, reviewed checked-in JavaScript should be executed: this is not an OS sandbox.

Offline execution rechecks the recorded **code**, not the historical model timing, cost, authentication or upstream identity. It never contacts a provider, dispatches GitHub Actions or reconstructs execution authority. A new live reproduction requires new applicable approval, current scope/ownership/freshness checks, existing eligible profiles and an explicit cost/call/time plan; running `verify.mjs` does not authorize it.

## Limits of the evidence

- **n=1 per live profile, one task, fixed run order.** No randomized repetitions, larger repository task, long-context test, adversarial study or significance claim. Timing can vary with load; wall-clock timing is not a controlled CPU benchmark.
- Model IDs are the configured provider/model identifiers observed by the harness. Underlying remote model identity was not independently audited. Current profile system text/tools matched at report time, but historical cross-run system hashes were not captured; thinking differs low/max.
- Cost fields are observed model-metadata estimates, not invoices or a USD hard cap. The published projection has no token-count breakdown. Response traces describe tool **requests**, not proof that every requested tool executed.
- No private tasks, source repositories, profiles, credentials, personal paths, raw provider errors or restorable grants are included. Hashes and reports are reference data only. Existing v1.0.0 tags/assets and production behavior are unchanged by this evidence addition.
- This data-only addition was checked locally; `[skip ci]` avoids new Actions work under the operator's quota concern. It does not waive product release gates or claim a new product release.
