# Multistage role routing: completed fresh-holdout pilot

**9/9workflows,27worker stages and9real JEV choices completed.** Investigation, implementation and read-only review ran separately with fresh SDK sessions/scopes; the optional single correction branch never activated. This changed the **benchmark workflow**, not the product into per-SDK-turn automatic model switching.

## Observations

| Workflow policy | Final official result-set EX | Full workflow time, sum/3 | Median/request | SDK rounds | Selector requests | Total observed USD estimate |
| --- | --- | --- | --- | --- | --- | --- |
| Fixed cheap: scout ->worker ->scout |2/3 |113.4143s |34.8184s |21 |0 |$0.01252140 |
| Fixed strong implementation: scout ->worker_strong ->scout |2/3 |156.8228s |51.3819s |24 |0 |$0.23535336 |
| JEV role choice before every stage |2/3 |117.8034s |38.4926s |21 |9 |$0.01304381 |

JEV chose **scout ->worker ->scout for all3questions**:6scout read stages,3worker implementation stages and0worker_strong selections. This exactly matched the cheap fixed role path. It did not improve observed EX, time or estimated cost over that matched control. Time/cost differences are small-sample observations, not significance/causal-overhead claims.

Across all arms: **66SDK rounds**, observed estimate **$0.260918572**, all sessions/file-I/O/Windows Jobs/children closed with complete usage/accounting. No source/config/profile/oldACL/cwd change, native/model/selector retry, fallback or deadline extension. Each stage used natural SDK completion (call capnull) and300seconds; selector choices used the explicit existing TypeSafejev-1.13.0 route effect, not a restored interactive Pi-session setting.

## Per-question results and review failures

| New holdout ID | Public sampling difficulty / DB | Fixed cheap | Fixed strong implementation | Routed | Review outcome |
| --- | --- | --- | --- | --- | --- |
|1368 |simple /student_club |pass |pass |pass |all3said no correction |
|825 |moderate /superhero |pass |pass |pass |all3said no correction |
|247 |challenging /toxicology |fail |fail |fail |all3said no correction despite unequal gold-result sets |

Initial EX and final EX stayed identical. All9reviews were valid strict JSON with needsFixfalse; there were **3review false negatives against the withheld initial EX criterion** (one in each policy on247). No reviewer requested correction, so none occurred. Do not claim the correction branch improved answers or was live-tested merely because its read/write eligibility/parser/preflight checks exist. Review opinion is not independent verification or user acceptance; official single-instance result equality itself has known semantic limitations.

## What is now actually stage-routed

Routed investigation and review each offered **scout,worker,worker_strong**, but the native file scopes and effective SDK tools were **read-only** for every candidate. Implementation/correction offered **only worker,worker_strong**, exactly one mutable query.sql and read-only task/schema/handoffs. Actual SDK metadata showed only`scope_read` for every investigation/review; read scopes had changed=false and all input hashes stayed intact. Scout never mutated files. Fixed stages did not make selector requests; routed stages made one each.

These are3role profiles, **not3distinct models**: scout and worker are both Luna/low, with different role prompts/tools; worker_strong is Astra/max. The selected profile remains fixed inside that stage's SDK loop. The parent declares decomposition, eligible candidates, typed handoffs and branch conditions; JEV does not autonomously discover or grant new stages/tools.

Reports are bounded named untrusted artifacts, not full prior conversations, instructions or authority. The implementer receives investigation assistance; the reviewer sees the candidate query but not database/gold results. Parent independently graded the initial query only for later review-quality measurement and never returned that feedback to a selector, reviewer or correction. Only a valid bounded needsFixtrue with concrete issues could admit the one predeclared correction stage; native/API errors are never correction requests or automatic retry triggers.

## Registered controls and full clock

The3new holdouts exclude all6previous benchmark IDs and were SHA-ranked before any outcome using seed`multistage-role-holdout-6a09e667`, one per difficulty across the same3official BIRD DBs. The first candidate in every slot had a nonempty bounded gold reference; no alternative was substituted. Gold3passed and empty-query negative3failed; labels/gold were hidden from all workers/router. The dataset/source/role/eligibility/branch/order protocol was committed at **b48fc1048aabb037e2d780bf0735024646cd4e49before the first live stage**.

Each question used all3workflow policies in Latin-position-balanced order. Unlike the earlier experiment, all controls had the same investigation/implementation/review structure and same optional correction rule; no multi-call arm was compared with an unrelated one-call baseline. These are **fresh holdouts**, so previous single-stage timings/accuracy are historical context, not paired measurements establishing a pipeline benefit.

A single parent performance.now clock begins before initial-stage policy choice and ends after every executed stage SDK/session/file/native Job/child cleanup, handoff creation and hidden initial/final readonly SQL verification. Human/manual code-review wait0: generated output remains SQL data executed only by the unchanged immutable/read-only deny-authorizer. Common corpus/protocol eligibility, one-time download/preparation/initial approval/report serialization are separate. Complete per-stage roles/models/toolsets/usage/cost/time and final rows are in [results.json](results.json); this metadata does not grant another execution.

## Reproduction and limits

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml benchmarks/selection-policy/multistage-bird-pilot/verify-metadata.mjs
```

Checks frozen6source/protocol hashes, exact9row/27stage order, eligibility/read-only SDK tools, known cleanup/accounting, no scout mutation, official reference digests and recomputed scores/time/cost sums with0providers. It **does not replay SQL without private query files**. `verify_local_sql.py` re-executed all9unchanged final local SQL artifacts against the same frozen BIRD/read-only metric, confirming original EX/result/DB digests with0new calls.

Raw CC-BY-SA4.0 BIRD questions/evidence/schema/DB/gold/generated queries and phase reports stay local, not relicensed under repository MIT. Sources remain [official Mini-Dev](https://github.com/bird-bench/mini_dev) and [birdsql/bird_mini_dev](https://huggingface.co/datasets/birdsql/bird_mini_dev), revisionf65faf4ae3b638c1fa6df1d3370c8d92c8366301, BIRD-SQL team attribution. Public IDs/hashes/numeric observations are provenance only; no private profiles/credentials/personal paths/raw provider errors or restorable grants.

n=3single-pass SQL holdouts and model+thinking+role-prompt differences do not establish general model/agent/routing superiority, full500BIRD or repository coding/security certification. Single-DB set-result EX ignores ordering/duplicates and can diverge from semantic intent. Selector confidence is not calibrated task-success probability. Model labels/cost estimates are configured observations, not upstream identity audits/account invoices. The experiment uses the same direct pinned SDK/shared safety boundary, not full product native approval/lease UX.

No old unfavorable result, frozen scoring function or user profile was changed to force a win. Product runtime/main/v1.0.0 assets remain unchanged, evidence commits use[skipci]and start noActions, and the closed9workflow batch is complete. The earlier generated-pyc path-history issue is documented in the prior pilot; no history rewrite or new generated artifact is hidden here.
