# Official BIRD subset: did the selector save time at preserved accuracy?

**18/18worker trials and6/6actual TypeSafe JEV choices completed.** Six preregistered public questions, two per difficulty across3small SQLite databases; not the full500leaderboard. Unlike the earlier fixed-profile study, every trial now has a **single continuous parent T0/T1 clock** covering selection, preparation, worker/file/session/Job cleanup and independent readonly SQL validation.

## Main observations

| Policy | Result-set EX | Full automated time, sum /6 | Median per request | Observed USD estimate, total | Worker SDK rounds | Real selector requests |
| --- | --- | --- | --- | --- | --- | --- |
| Fixed Luna / low |3/6 (50.0%) |65.9595s |11.0877s |$0.00850056 |18 |0 |
| Fixed Astra / max |5/6 (83.3%) |160.5488s |23.8051s |$0.46144000 |26 |0 |
| JEV-selected profile |3/6 (50.0%) |66.4048s |11.2362s |$0.00886100 |18 |6 |

The selector chose **worker/Luna on all6questions**. It reproduced the fixed-Luna correctness pattern, including the same3misses. It did not preserve the observed fixed-Astra accuracy and did not beat the fixed-Luna baseline on observed time, cost or accuracy in this sample. Being faster than always-Astra is therefore **not** a quality-preserving selector win here.

The fixed-Luna versus selected total-time difference is only0.4453s over6requests and is not a significance claim. Stochastic worker latency can offset selection overhead. Selection phases themselves totaled2.3931s, including first-call module/cold setup, request, validation and choice parsing; do not describe all of that as remote inference latency. The6selector responses used3138reported input tokens and198output tokens; pinned list-price input estimate$0.000131796, not an invoice. Overall18workers+6choices estimate **$0.478801556**.

## All registered cases — none dropped or retried

| Official question ID | DB | Public sampling difficulty (withheld from workers/router) | Fixed Luna | Fixed Astra | JEV choice / EX |
| --- | --- | --- | --- | --- | --- |
|1380 |student_club |simple |pass |pass |Luna /pass |
|1317 |student_club |moderate |fail |pass |Luna /fail |
|791 |superhero |simple |fail |pass |Luna /fail |
|773 |superhero |challenging |pass |pass |Luna /pass |
|228 |toxicology |moderate |pass |pass |Luna /pass |
|263 |toxicology |challenging |fail |fail |Luna /fail |

Question791and1317are paired observations where the stronger fixed profile passed and the cheap fixed/selected profile did not. Question263was missed by both profiles. This diagnoses the observed policy trade-off; it is not permission to send gold results to the selector, alter candidate rubrics or rerun until routing improves. Self-reported selector confidence is a choice score, **not a calibrated probability of SQL correctness**.

All18outputs were executable SELECT queries within the restricted readonly evaluator; failures above are unequal official gold-result sets, not hidden transport failures. All worker usage/accounting, SDK session disposal, file-I/O completion, Windows Job/child exit and dataset/spec/schema integrity checks were confirmed. No model/profile/cwd switch, automatic retry, native/selector error, time extension, query rescore, post-hoc task drop or extra judge occurred.

## Time boundary and policy definition

T0: request-ready before fixed or JEV policy selection, after common corpus/protocol eligibility is loaded. T1: selected worker/session/file-I/O/Job/child cleanup complete **and** independent SQL evaluator exited with dataset-integrity checks. All phases use the same parent `performance.now()`; published phase sums agree with total within1ms for every row. Approval/manual code-review wait is0: model output is SQL data, parsed/executed only by immutable/read-only SQLite with a deny-by-default authorizer, never generated Python/JavaScript.

Per-trial preparation/profile/scope checks, cold phase imports, file copying, worker startup/model/tool work, cleanup and reference/predicted query validation are included. One-time dataset download/schema snapshots/reference qualification, common corpus/manifest loading before T0 and final report serialization are excluded. Worker deadline stays300seconds, selector10, SQL5/evaluator-child10. No clock was spliced from separate assistant turns, and no manual-review gap was subtracted later.

This is a **selection-policy API experiment** over one common direct pinned-SDK executor/shared safety boundary, not the full JEV product orchestration/approval UX. The explicit selector backend is the available existing environment TypeSafe requested/returned model`jev-1.13.0`; it does not assert restoration of the interactive Pi session's method. The selector receives public question/evidence and fixed agent rubrics, not schema rows, gold SQL, difficulty, validation feedback or prior outcomes. Whether richer schema-aware routing or different rubrics/backends help is an untested new study, not a correction applied to this one.

## Public dataset provenance and reproduction limits

Official sources: [BIRD Mini-Dev](https://github.com/bird-bench/mini_dev), [birdsql/bird_mini_dev](https://huggingface.co/datasets/birdsql/bird_mini_dev), pinned revision`f65faf4ae3b638c1fa6df1d3370c8d92c8366301`. Attribution BIRD-SQL team; dataset license **CC BY-SA4.0**. The500questions and3SQLite DBs were actually downloaded and integrity-checked. Acquisition and bounded deterministic sampling precede every model outcome; all6references passed and all6empty-query controls failed. No sampling candidate was skipped.

Raw questions, evidence, schema, DBs, gold SQL and generated queries are retained only in the private local dataset/fixture area, **not relicensed or redistributed under repository MIT**. Public [results.json](results.json) includes question IDs, query/input/database/result-set hashes, numeric timings/costs, independent EX flags and whitelist-only worker/selector metadata. No credentials, raw profile bodies, personal paths or provider exception bodies are included in the current source/data projection.

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml benchmarks/selection-policy/bird-mini-dev-pilot/verify-metadata.mjs
```

The public verifier checks frozen7source/protocol hashes, exact18row order,6selector requests, policy score/time/cost sums, continuous-clock phase sums, dataset/reference-version digests and known accounting/cleanup. It makes0provider calls but **does not replay historical SQL** because query contents are not distributed. `download.py`, `prepare.py` and `safe_sql.py` support rebuilding acquisition/sampling and evaluating one's authorized local query artifacts; another live rerun needs new applicable authority, not a protocol/manifest file.

## Limits and housekeeping

-6questions,3small DBs, one generation per policy/question: no broad/statistical routing claim, full500score, SWE/coding generalization or model-only ranking. Low/max thinking remains part of the operational candidates. Public data may be in model training. Single-DB set-result matching ignores ordering/duplicates and can have semantic false positives. Restricted SELECT/5-second/row/result-byte bounds adapt the official EX, not its full30-second/other-dialect/efficiency/F1 evaluation.
-This sample found a real accuracy/time trade-off, but **no selector benefit over always-Luna and no preserved-Astra-accuracy speedup**. Do not turn the unfavorable result into a favorable benchmark by changing prompts, sample or rubric after observing outcomes.
-The unpaid preparation phase fixed a synthetic Python fixture connection-close issue; no paid attempt was retried. A generated `.pyc` was accidentally included in the initial preregistration commit, then removed from current head before live requests with a scoped ignore. Its compiled-source filename contained a local path; no key/DB values were in that artifact. The earlier commit still retains it; history was not force-rewritten.
-No new Actions job, runtime/dependency/profile install, old ACL repair/elevation, main merge, product runtime change or v1.0.0 release/tag replacement occurred. Fresh scopes were protected at creation and shared native identity/cancel/Job guarantees stayed intact. The closed18worker/6selector batch is finished; no additional paid work is authorized by these records.
