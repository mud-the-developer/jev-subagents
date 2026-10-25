# BIRD Mini-Dev selection-policy pilot — completed

**18/18worker trials and6/6real selector calls completed.** Fixed Luna3/6EX in65.96s; fixed Astra5/6in160.55s; JEV-selected3/6in66.40s, with all6choices selecting Luna. This sample showed no benefit over always-Luna and no accuracy-preserving speedup over always-Astra. See [RESULTS.md](RESULTS.md) and [results.json](results.json); limitations and unfavorable results are retained.

Question: **does paying for a JEV choice reduce full automated turnaround while preserving SQL execution accuracy, compared with always using either candidate?** The prior fixed-profile JEV/direct study made0routing requests and could not answer this.

## External benchmark and acquisition

Sources: [official Mini-Dev repository](https://github.com/bird-bench/mini_dev), [official Hugging Face dataset](https://huggingface.co/datasets/birdsql/bird_mini_dev), pinned HF revision`f65faf4ae3b638c1fa6df1d3370c8d92c8366301`. License **CC BY-SA4.0**, attribution **BIRD-SQL team**. Questions/SQLite DBs remain in a private local dataset directory, **not redistributed under this repository's MIT license**. Checked-in acquisition/source hashes, problem IDs and numeric observations are factual provenance; no raw task/schema/gold SQL/DB/model query is published.

The SQLite split has500original SELECT questions (148simple/250moderate/102challenging). `download.py` retrieved that278,513-byte question file/card and the three smallest official SQLite DBs(superhero,student_club,toxicology) via verified HTTPS ZIP ranges: ~1.39MB transferred instead of the800,943,648-byte full archive. Exact selected-member sizes/CRC/SHA256, question SHA and archive ETag are in [acquisition.json](acquisition.json). Full-archive SHA is explicitly unavailable; selected files were ZIP-CRC/format/byte-count/hash checked. No archive-wide extraction, path traversal or fallback mirror.

## Frozen small sample, not a leaderboard score

Six questions, selected before model outcomes with seed`bird-selector-pilot-510e527f` from availability-constrained DB/difficulty slots:
- student_club: simple1380,moderate1317
- superhero: simple791,challenging773
- toxicology: moderate228,challenging263

Each DB contributes2questions and each difficulty contributes2. Deterministic SHA ordering selected the first bounded nonempty SELECT reference per slot; **no reference was skipped**. All6gold references passed and all6initial empty-query negative controls failed. These difficulty labels are used only for preregistered sampling/reporting, **not supplied to the worker or JEV**. Public questions may have appeared in training; this is a6-question,3-small-DB pilot, not the full500score or a general coding benchmark.

## Three matched policies

`fixed_luna`: existing worker/Luna low. `fixed_astra`: existing worker_strong/Astra max. `jev_select`: one actual product routing effect/validated choice among those same two profiles, then exactly one worker. Both profiles remain unchanged; their body hashes are fixed. The router receives only an English wrapper with verbatim public question/evidence and non-sensitive candidate rubrics: no gold SQL, difficulty, validation result, private source/history, claimed performance or quota. No route-then-route duplication, judge, extra worker, retry/fallback or post-hoc task replacement.

The explicit benchmark selector is **TypeSafe requestedmodel`jev-1.13.0`**, using the available existing environment credential effect-locally and the product's endpoint/response/accounting validation. The current interactive Pi session selection is **not restored or asserted identical**. This is a selection-API policy experiment above the same direct pinned-SDK/shared-safety executor in all arms, not a complete product orchestration/approval UX benchmark.

A fixed seed and all6Latin-order permutations balance each arm across positions over the6questions. [protocol.json](protocol.json) fixes18worker runs and6selector requests. SDK round counts are uncapped/natural completion, worker300seconds, selector10seconds, scope preparation45seconds, readonly SQL5seconds/evaluator-child10seconds. No hard USD cap; observed worker/JEV cost fields are model-metadata/list-price estimates, not invoices. Native/SDK/selector failure or unknown accounting/cleanup stops the batch with failed/unstarted denominators retained. A completed model producing wrong/rejected SQL is an execution-accuracy failure, not retried.

## One continuous parent clock, no manual code-review gap

T0 is **request-ready before fixed/JEV choice**. T1 is after the worker/session/file-I/O/Windows Job/child have closed and independent SQL validation/database-integrity checks have completed. The **same parent `performance.now()`** records selection, per-trial profile/input/scope preparation, SDK worker plus cleanup, verification and full wall time. Fixed choices get no selector request but keep the same boundaries. Startup imports within these phases count; one-time dataset download/schema snapshot/reference qualification and common corpus/protocol eligibility load before T0 are excluded. Initial operator approval and final report serialization are separate/excluded; manual review wait0.

Unlike arbitrary generated program execution, model output is **SQL data only**. Python3.14.8's existing sqlite3/SQLite3.50.4 opens the exact pinned DB read-only/immutable with query_only plus an authorizer denying writes/ATTACH/PRAGMA/extension/file functions. Only SELECT/WITH and a single native parsed statement are admitted. Row/result-byte/progress-time bounds apply, DB hashes match acquisition before and after, and no generated Python/JavaScript runs. Thus verification is automatic inside the clock, not paused for assistant/human code review.

Execution accuracy uses the official evaluator's `set(predicted_rows)==set(gold_rows)` convention, ignoring duplicates/order. This is a restricted SELECT-only single-DB EX adaptation with stricter5-second query/5000-row/1MiB result bounds, not the official30-second/full-dataset/alternate-dialect VES/F1 evaluation. Evaluation false positives/ambiguity of single-instance result matching remain possible.

## Preflight and safety

`offline_sql_tests.py` checked valid SELECT/CTE,8unsafe/multiple/write/extension/file query rejections, progress interruption and unchanged DB bytes. Gold/empty-negative controls passed for all6questions. `offline-selector.mjs` uses an explicit dummy credential/mock fetch to check fixed-arm0requests, exact allowlisted route shape/choice/accounting and bounded rubrics; mock data are never live evidence. Initial synthetic connection-close cleanup was corrected before live requests; Python connection context managers alone do not close handles.

Workers use the already qualified direct SDK harness: existing Bun1.4.3/SDK0.85.1, no extensions/discovery, no shell/path tool, only one mutable SQL file and read-only task/schema IDs, no raw credential inheritance, fresh native SID/DACL/identity/context checks, owned Windows Job and known cleanup. Fresh private fixtures are protected at creation under the same workspace; no old ACL/profile/runtime/dependency modification. Shared safety utilities mean this is not removal of all JEV-derived code. Only the policy differs between arms.

Unpaid Windows background-monitor compatibility failed before provider requests; no paid request was retried or moved to another provider. The explicit trusted command execution tool is used for the first actual batch. No new Actions dispatch, product runtime/tag/release change or profile creation is involved; evidence commits use `[skip ci]`. Protocol/hash/data records are not execution grants and do not authorize another batch.
