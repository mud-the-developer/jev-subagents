# Multistage BIRD extension: ten distinct questions

This extends the [completed3-question role pilot](../multistage-bird-pilot/RESULTS.md) to **10questions ×3matched policies =30workflows**. The original3cases/9workflows remain included unchanged and are **not rerun**. Only7new cases/21workflows execute here. The user requested expansion after seeing the pilot; therefore this is a **sequential extension**, not a claim that n=10was preregistered before the original pilot. Original and extension cohorts will be reported separately as well as pooled.

## Fixed sample before the new outcomes

Keep original IDs1368,825,247 from commitb37d53153a89340edc76f009ffde267354e8a940. New SHA-ranked holdouts use seed`multistage-role-extension-10-3c6ef372`, excluding those3and all6earlier single-stage questions:

| New ID | DB | Sampling difficulty, withheld from workers/router |
| --- | --- | --- |
|1323 |student_club |moderate |
|1460 |student_club |challenging |
|745 |superhero |simple |
|744 |superhero |challenging |
|248 |toxicology |simple |
|232 |toxicology |moderate |
|1411 |student_club |simple |

The pooled10cover all9DB/difficulty combinations, with4simple/3moderate/3challenging and4student_club/3superhero/3toxicology. First SHA-ranked candidate in each predefined new slot qualified with a bounded nonempty correct reference; no alternative task was substituted. All7reference and7empty-negative controls passed before live requests. Distinct IDs do not prove semantic independence, lack of training contamination or coverage of larger DBs.

## Unchanged workflow, roles, scoring and clock

- fixed_cheap: scout ->worker ->scout; worker correction only if valid review requests it.
- fixed_strong: scout ->worker_strong ->scout; worker_strong correction only if valid review requests it.
- routed: one actual JEV choice before every declared stage. Read-only investigation/review candidates=scout/worker/worker_strong; implementation/correction candidates=worker/worker_strong only.

Stage SDK models stay fixed. Scout and worker currently share Luna/low with different role prompts/tools; worker_strong uses Astra/max. Bounded named handoffs are untrusted data, not new authority. Read scopes expose only scope_read; only query.sql is mutable in implementation/correction. Hidden initial EX grades are never sent to a worker/selector or used to trigger correction. Strict reviewer JSON may admit exactly one declared correction; malformed reports/native/model/selector failures never cause fallback/retry.

`run-workflow.mjs` changes only batch-count/data paths and references the **same frozen phase-worker**. The zero-provider equivalence test normalizes those explicit plumbing differences and compares the entire remaining harness byte-for-byte, proving prompts, candidate rubrics, stage rules, deadline/call caps, SQL metric, timing and cleanup code remain unchanged. All original6frozen source hashes, old result hash, current profiles and SDK version are checked. Product/runtime/global profiles/previous experiments remain unchanged.

The same single parent clock covers initial choice through all executed stage selections/preparations/handoffs/SDK/session/file/WindowsJob/child closure and initial/final immutable readonly SQL grading. No manual code-review wait or spliced assistant clocks. Corpus eligibility/download/approval/report serialization are separate. Stage deadlines300seconds, SDK rounds uncapped; TypeSafejev-1.13.0 remains the explicit existing environment selector, not restored interactive-session state.

## Closed additional batch

**21new workflows,63baseworker stages, max84with one correction per workflow;21baseJEVrequests, max28with routed corrections.** SDK call capnull/natural completion, one worker per stage; no hard USD cap. Stop on any native/SDK/provider/selector error, uncertain accounting/cleanup, freshness violation or oversized report; retain unfinished denominators and never automatically retry. Theoretical pooled total given the completed pilot's0corrections is90base/max111worker stages and30base/max37selector requests. This does not grant another batch after completion.

The fresh private fixture is protected at creation, uses the unchanged workspace, and preserves old checkouts/ACLs/patches. Existing Bun1.4.3/SDK0.85.1/Python3.14.8/SQLite3.50.4 only; no install/upgrade/elevation, native guard weakening or test timeout/parallel-limit change. No product implementation, main merge/tag/release or Actions dispatch; evidence commits use[skipci].

Official [BIRD Mini-Dev](https://github.com/bird-bench/mini_dev)/[HF birdsql](https://huggingface.co/datasets/birdsql/bird_mini_dev), revisionf65faf4ae3b638c1fa6df1d3370c8d92c8366301, attribution BIRD-SQL team, datasetCC-BY-SA4.0. Raw questions/evidence/schema/DB/gold/generatedSQL/phase reports stay private, not MIT-redistributed. Public source and numeric metadata/query/result hashes are factual evidence. Restricted SELECT/single-DB set-result EX is not full500/VES/F1, broad repository coding or security certification. The shared direct-SDK selection-API experiment does not measure full product approval/lease UX. Reported price estimates are not invoices; routing confidence is not a calibrated success probability. Small sample and sequential-extension limits remain even at n=10.
