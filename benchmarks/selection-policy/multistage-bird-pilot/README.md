# Multistage BIRD role-routing pilot — registered before execution

The earlier [single-stage selector pilot](../bird-mini-dev-pilot/RESULTS.md) selected worker/worker_strong once perquestion and never used scout. Its unfavorable results stay unchanged. This new benchmark tests **role choice at declared stage boundaries**, not per-SDK-round model swapping or a new production feature.

## Three role profiles, two configured models

- scout: Luna/low, read-only profile instruction/tools.
- worker: the same Luna/low model/thinking, implementation instruction/tools.
- worker_strong: Astra/max, implementation instruction/tools.

Profiles are existing user configuration, not benchmark-created or overwritten. Body/model/thinking/tool hashes/metadata are fixed. Different role prompts, low/max thinking and a small public SQL sample prevent general model ranking.

## Workflow and eligible roles

| Stage | Eligible routed candidates | Effective SDK tools | Scope |
| --- | --- | --- | --- |
| investigate |scout,worker,worker_strong |scope_read only |task/schema read; bounded English analysis report |
| implement |worker,worker_strong |scope_read/edit/write |query.sql mutable; task/schema/analysis read-only |
| review |scout,worker,worker_strong |scope_read only |query/task/schema/analysis read; strict JSON review |
| correct (conditional, max1) |worker,worker_strong |scope_read/edit/write |query.sql mutable; prior reports read-only |

Every routed stage requests a fresh JEV choice; fixed stages call no selector. Selection occurs **once before the stage**, with that worker's model fixed throughout its uncapped SDK round loop. The parent explicitly owns stage decomposition and eligibility. Mutation never offers scout. Read scopes remain read-only even if the selected profile normally permits editing. Mechanical preflight proved actual SDK tool sets and rejected a fabricated scout-mutation input before any model request.

The selector sees public question/evidence and current stage/role requirements, not gold SQL, difficulty labels, hidden grades or full private report/history. Reports passed to later workers are bounded named **untrusted data**, not new instructions or execution authority. Parent does not replay entire conversations.

Review must return only `{ "needsFix": boolean, "issues": string[] }`, with max8issues/512UTF8bytes each and a concrete issue when requesting correction. Markdown/extra keys/malformed review is retained as a format failure and **does not** trigger hidden fallback or retry. A valid needsFix=true permits exactly one separately declared correction stage. This is a planned workflow branch, not a retry of a failed native/model job. No second review/correction loop. Read-only reviewer cannot directly mutate the query.

## Matched controls and fresh holdout

Three previously unused official BIRD questions, one per difficulty across the same3available DBs:1368(student_club/simple),825(superhero/moderate),247(toxicology/challenging). Selection seed`multistage-role-holdout-6a09e667`; all six previous question IDs excluded before model outcomes. First SHA-ranked candidate in each slot had a nonempty bounded correct reference; no fallback replacement. Difficulty/gold remain hidden. Raw CC-BY-SA4.0 data/schema/reports/queries stay local, with BIRD attribution and acquisition hashes inherited; only metadata and code are published.

Three matched workflow policies for each question:
- fixed_cheap: scout ->worker ->scout ->worker only if valid review requests correction.
- fixed_strong: scout ->worker_strong ->scout ->worker_strong only if valid review requests correction.
- routed: JEV picks from each stage's eligible set above, including a correction only when requested.

This holds workflow structure/handoff/review rules constant rather than comparing a multi-call pipeline against an unrelated one-call baseline. The fixed Latin order balances each policy's position across3questions. Existing single-stage scores are historical context, **not paired fresh-holdout controls**. n=3single-pass SQL cases is a bounded workflow pilot, not a full BIRD/coding/security certificate.

## Closed limits and grading

9workflows,27baseworker stages, at most36worker stages including one correction each. Routed policy has9baseJEVrequests/at most12with corrections. SDK model-call capnull/natural completion; each stage one existing profile and300seconds. No hard USD cap, native failure retry, model/cwd/profile fallback, deadline extension, extra judge or automatic new workflow. Selector TypeSafe requestedjev-1.13.0 remains explicit environment configuration, not restored interactive Pi-session state. All model/selector failures, scope freshness violations, unknown accounting/cleanup or oversized report stop further scheduling; unstarted denominator retained.

One continuous parent clock starts before initial stage selection and ends after all executed stage SDK/session/file/WindowsJob/child cleanup and final independent readonly SQL grading. It includes phase choices, preparations, handoff-file creation and hidden initial/final validation; no human/model-code review wait because only readonly-authorized SQL data is evaluated. Common dataset eligibility/download/approval/report serialization are separate. All arms use the same pinned SDK/direct-worker/shared safety boundary, not the full product's native approval/lease/orchestration UX.

Initial SQL is independently graded **before** review solely to measure review precision/recall; that grade is never supplied to any selector/worker or correction decision. The branch depends only on valid reviewer output. Final result-set EX is primary; workflow-format/scope contract, reviewer false positives/negatives, corrections, role/model/tool selections and full time/cost/calls are separate observations. Do not parent-repair a failed answer, cherry-pick, change frozen tests/rubrics or drop a bad case after results.

The existing frozen readonly SQLite evaluator/DB versions and deny-authorizer are reused without altering previous scoring. Private source/runtime/config/oldACLs stay unchanged; fresh test directories are protected at creation. No runtime/dependency/profile install, product implementation, main merge/release/tag or Actions dispatch. `[skip ci]` metadata records grant no future execution authority. See `protocol.json`, the frozen source manifest and zero-model preflight evidence.
