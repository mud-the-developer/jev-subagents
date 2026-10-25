# Multi-module quality suite v2 — completed registered comparison

**12/12live trials completed.** Both operational configurations passed6/6task trials and96/96contract groups. See [RESULTS.md](RESULTS.md) for complete observations/limits and [live-results.json](live-results.json) for whitelisted per-trial metadata. The frozen protocol captured0live trials before execution and is deliberately not rewritten into a progress counter. The earlier [one-task pilot](../integer-ranges-v1/README.md) remains a pilot and is not reused as a v2 observation.

## What is improved

| Task | Engineering surface | Granted source modules | Parent-held checks |
| --- | --- | --- | --- |
| async-cache |Single-flight concurrency, TTL at resolution, invalidation races, rejected load eviction, client normalization |cache.mjs/client.mjs |14groups with deterministic clock/deferred promises; no sleeping |
| record-gateway |Owned credential fields, default-deny resource policy, validation before repository access, mutation spies, public response projection |policy.mjs/gateway.mjs |17groups; no real server/customer data |
| dependency-plan |Two-module planner/render integration, schema/cycle errors, immutable layered scheduling, stable ASCII ordering |planner.mjs/summary.mjs |17groups including200seeded DAGs checked against independent construction-depth expectations |

Each task contains a deliberately faulty `initial/`, a parent-only correct `reference/`, its full `SPEC.md` and `checks.mjs`. References are not model outputs. Before any live run, every reference must pass every group; each original must fail; an exact single-bug mutant must fail its targeted check. This tests checker sensitivity rather than displaying only successful solutions.

Current offline controls: async-cache initial5/14/reference14/14; record-gateway initial5/17/reference17/17; dependency-plan initial1/17/reference17/17. Mutants disable invalidation, permit unarchived admin deletion, or return a partial cycle plan; all are detected. See [controls.json](controls.json).

## Registered and executed experiment

[protocol.json](protocol.json) defines **3tasks ×2conditions ×2repeats =12independent trials**. The executed conditions preserved the existing operational profiles: worker/Luna low and worker_strong/Astra max. This is not a model-only causal comparison because thinking differs. A common-thinking model study needs separately approved benchmark-profile preparation and an amended/frozen protocol **before** its first live request; existing user profiles must not be silently changed.

- Same common [TASK.md](TASK.md), task-specific spec, initial bytes, file-ID mode and caps for each condition/repeat. Each job gets only its two existing mutable modules and read-only SPEC; no shell, discovery, new file, verifier, reference, prior output or test-feedback tool is granted.
- Fresh protected fixture/scope and a fresh worker per trial; unchanged current cwd and native SID/DACL/file-identity/freshness/lease/cancellation checks. Capture each trial's public model/thinking/tool metadata and system-text hash without publishing raw profiles; incompatible system/tool changes invalidate comparability. No reuse of a prior result as an input solution or execution grant.
- A fixed seed shuffles task order; paired AB/BA reversal counterbalances condition order across repeats. Runs are sequential, so competing workers do not fabricate a parallel latency comparison.
- Operator-amended limits before the first live trial: **one worker,SDK natural completion with no model-round count cap,300seconds**. The closed batch remains12trials/3600execution seconds, with no automatic retry/escalation/model switch/time extension. There is no SDK-count or hard USD ceiling; stored model-cost estimates are not invoices. See [AMENDMENTS.md](AMENDMENTS.md).
- Native execution failure/cancellation/unknown cleanup or accounting stops further scheduling and retains failures/unstarted denominators. A completed code attempt failing independent checks is a task failure, never parent-repaired or silently rerun. No additional model-based judge is planned.

The operator separately requested execution with no SDK call-count cap before any v2 trial. Existing low/max profiles are retained, not silently changed or claimed as a model-only comparison. These files still grant no authority: every trial must use current genuine native job approval or applicable live Full Access, with current scope/freshness/ownership checks. The protocol's0live counter is a preregistration snapshot, not an execution-progress counter.

## Scoring decided before results

Primary functional score is **all contract groups pass per task trial**, with equal task weight and completed/planned denominators visible. Do not pool48groups into a misleading overall model ranking. Secondary observations include case failures, cross-module regressions, allowed-file/scope adherence, unsupported test-success claims, SDK rounds, elapsed time, observed cost estimates and cleanup/lock state. Generated code is manually reviewed before the parent runs it in keyless test environments.

No test edits, added hidden requirements, best-of selection or task replacement after seeing live outputs. Any spec/reference/test defect discovered before execution requires a new manifest; after execution it requires retaining the invalidation/amendment, not retrospectively selecting a better result. Report per-task paired observations and repeat ranges; n=2per task/condition is still not a broad statistically significant ranking, real-world repository acceptance or security certification.

## Offline qualification

Using existing standalone Bun1.4.3 from the source root:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json benchmarks/live-model-quality/suite-v2/verify-controls.mjs
```

The verifier checks the frozen input manifest, then runs initial/reference/mutant controls in owned temporary directories with30-second child bounds and keyless environments. It makes0provider calls and does not install dependencies or dispatch Actions. It executes checked-in JavaScript under the current OS user, not a sandbox: use trusted reviewed source. Unknown child exit retains the temporary evidence instead of sweeping it.

Recheck the recorded model outputs without new provider calls using `benchmarks/live-model-quality/suite-v2/verify-recorded.mjs` with the same sealed Bun flags; see [the results reproduction guide](RESULTS.md#reproduce-the-recorded-code-offline). It validates all24output module hashes and repeats the original checks, not historical model billing/latency.

The fixture/checker hashes and scheduled IDs are reference data only. No private task/profile/credential, machine path, raw provider error, stored approval, product runtime change or v1.0.0 asset replacement is included. Evidence-only commits use `[skip ci]` for the operator's Actions quota concern; no product release gate is waived.
