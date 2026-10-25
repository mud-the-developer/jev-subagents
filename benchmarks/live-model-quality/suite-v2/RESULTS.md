# Completed v2 operational-profile comparison

**12/12 registered live trials completed; no SDK round-count cap.** Three two-module synthetic maintenance tasks, two independent repeats per configuration, in the preregistered counterbalanced order. This is a comparison of configured operational profiles, **not** a model-only causal ranking: Luna used low thinking and Astra used max.

## Primary result and observed resource use

| Configuration | All-groups-pass trials / planned | Passed contract groups | SDK rounds | Native-job elapsed median [range] | Observed USD estimate, total |
| --- | --- | --- | --- | --- | --- |
| A: worker / Luna / low |6/6 |96/96 |29 |20.0815s [17.119,26.962] |$0.02086636 |
| B: worker_strong / Astra / max |6/6 |96/96 |48 |172.3535s [109.839,201.937] |$1.781676 |

Total: **77SDK rounds**, observed estimate **$1.80254236**, JEV selection/judge requests0. Every job used SDK natural completion (`modelCalls:null`, `perWorkerCalls:null`), one worker and the unchanged300-second execution bound. No timeout, native failure, retry, model/profile change or deadline extension occurred. The original12-call proposal was explicitly amended and committed before the first live request; see [AMENDMENTS.md](AMENDMENTS.md).

## Paired task observations

Elapsed times are shown in repeat1/repeat2 order, not sorted to hide a worse run. Native-job elapsed metadata is not isolated server/CPU latency and excludes parent review/checking.

| Task | A pass groups by repeat | B pass groups by repeat | A elapsed seconds | B elapsed seconds | A SDK rounds | B SDK rounds |
| --- | --- | --- | --- | --- | --- | --- |
| dependency-plan |17/17,17/17 |17/17,17/17 |19.480,20.470 |124.727,109.839 |5,5 |8,8 |
| async-cache |14/14,14/14 |14/14,14/14 |26.962,20.389 |201.937,163.873 |5,5 |8,8 |
| record-gateway |17/17,17/17 |17/17,17/17 |17.119,19.774 |180.834,197.314 |4,5 |8,8 |

Both configurations changed only the two declared mutable files inside each fixture. The original SPEC/checker hashes stayed unchanged, no extra fixture files appeared, cleanup was confirmed, and no lock remained. All workers explicitly reported **no tests run**; the native result remained `completed_unverified`/`needs_human_review` until the parent reviewed each generated pure module and ran independent checks. Test-group counts are secondary observations; the primary score weights each task trial equally.

## Controls, preregistration and invariants

- Initial source/spec/common task/checker/reference inputs and scheduled IDs were committed before execution. Same task bytes, file-ID permissions, system-text hash and declared tool list were verified for every trial; only configured provider/model and thinking differed. Current profile bodies were not published or edited.
- Initial negative controls: async-cache5/14, record-gateway5/17, dependency-plan1/17. Correct references:14/14,17/17,17/17. Targeted single-bug mutants fail the intended invalidation, unarchived-deletion and cycle checks. None were granted to live workers.
- The dependency task includes200seeded DAG depth-oracle instances per trial. The cache uses deterministic clock/deferred promises rather than wall-clock sleeps. Gateway checks repository call ordering/mutations and public response projections. Inputs include frozen/invalid/inherited-field cases as specified; proxy/accessor side effects are explicitly outside the gateway task.
- Every attempt used fresh initial files and fresh native file scope under the same workspace. Existing files/ACLs/profiles were left unchanged; fresh fixture directories were protected at creation. No previous solution, test output or reference was sent to a later worker. AB/BA reversal counterbalanced condition order across repeats; no concurrent workers competed for latency measurements.
- The original prepared manifest captured0live runs; it is deliberately not rewritten into a running counter. [live-results.json](live-results.json) contains the final denominator, whitelisted telemetry, profile/system/code hashes and exact check outcomes. Those records never restore approval or execution authority.

## Reproduce the recorded code offline

From the source root with an existing Bun1.4.3:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json benchmarks/live-model-quality/suite-v2/verify-recorded.mjs
```

This verifies the frozen21-input manifest and initial/reference/mutant controls, then checks all24recorded worker-module hashes and runs each output with the **same** held-out tests. Source files under `outputs/<trial-id>/` are exact recorded worker bytes, not parent-corrected implementations. Child environments are keyless and child checks retain30-second bounds. The script contacts0providers, installs nothing, dispatches no Actions and cannot reproduce historical model cost, authentication or elapsed time. Execute only trusted reviewed JavaScript; this is not an OS sandbox.

## What this does and does not show

- **No observed correctness separation:** both achieved full scores. These tasks exhibit a ceiling effect for these configurations; a tie on this suite is not equivalence on harder or larger work. Do not change tasks/tests or add a harder hidden requirement retrospectively to manufacture a winner.
- Luna/low used fewer rounds, less reported elapsed time and a lower cost estimate **on this registered suite**. Because model and thinking differ, these differences are not isolated model effects. Two repeats per task, only three tasks, fixed machine/session and non-randomized machine load do not support a general capability ranking or significance claim.
- The scope is two-module deterministic maintenance with file-ID tools. No worker shell/test execution, large repository exploration, long-context recovery, real customer data, physical UI task acceptance or broad security certification was evaluated.
- Provider/model labels are configured identifiers observed by the harness, not an independently audited upstream model identity. Cost fields are configured model-metadata estimates, not account invoices; token breakdowns are not in this public projection. Tool request traces are not proof of every individual execution.
- Existing source/runtime/dependencies and v1.0.0 release assets are unchanged. These evidence-only commits use `[skip ci]` under the operator's Actions quota concern; local offline reproduction passed, not a new product CI certification. Further live studies, profile changes or publications need new applicable authority.
