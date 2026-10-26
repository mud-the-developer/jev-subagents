# Ten-question multistage role-routing results

**10distinct BIRD questions ×3policies =30/30completed workflows.** Original3questions remain unchanged/not rerun;7new questions supplied21additional workflows. This is the user-requested sequential extension after seeing the pilot, not an initial n=10preregistration claim. No sample was dropped or replaced after any new model outcome.

## Pooled10: same stage structure and grading

| Workflow policy | Final EX | Full workflow wall, sum/10 | Mean/request | SDK rounds | Actual JEV choices | Total observed USD estimate |
| --- | --- | --- | --- | --- | --- | --- |
| Fixed cheap: scout ->worker ->scout |8/10 |364.3441s |36.4344s |70 |0 |$0.04338148 |
| Fixed strong implementation: scout ->worker_strong ->scout |8/10 |600.9524s |60.0952s |80 |0 |$0.92429248 |
| JEV choice before each eligible stage |7/10 |391.7630s |39.1763s |73 |31 |$0.04410296 |

In this sample the routed policy did **not** beat the cheap matched control on observed accuracy/time/cost. It used the same Luna/low implementation role on every question and never chose worker_strong. Do not infer that JEV causally harms accuracy from one discordant generation: models were generated once perpolicy/question and even identically configured workers can vary. Likewise8/10vs8/10does not establish equivalence or a general model ranking.

All30workflows executed **91worker stages** (90base+1declared correction),223SDK rounds and31actual selector requests. Overall observed estimate **$1.011776916**, including the old pilot; additional batch only **$0.750858344**. These are complete metadata/list-price estimates, not account invoices. No native/SDK/provider/selector failure, automatic retry, fallback, test/timeout relaxation or unplanned profile/model/cwd switch occurred; all known accounting/session/file-I/O/Windows Job/child closure and readonly-input integrity checks passed.

## Keep cohorts visible

| Cohort | Questions/policy | Fixed cheap EX /wall | Fixed strong EX /wall | Routed EX /wall |
| --- | --- | --- | --- | --- |
| Original pilot, unchanged |3 |2/3 /113.4143s |2/3 /156.8228s |2/3 /117.8034s |
| New extension |7 |6/7 /250.9298s |6/7 /444.1297s |5/7 /273.9596s |
| Pooled |10 |8/10 /364.3441s |8/10 /600.9524s |7/10 /391.7630s |

New7selection/protocol/source hashes were committed at **4f2d13398e2b4411c4a4b1f888d233121a017f13before any extension worker/selector request**. The original result file is hash-bound and every retained pilot row matches it exactly apart from explicit cohort/index labels. The same prompts/rubrics/scoring/safety/deadline code was byte-compared after normalizing only batch-count/data-path changes; existing frozen child-worker/safety/runtime sources remain shared unchanged. Latin-position rotation continues across the7new cases; maximum arm-position imbalance is1. Separate processes/cohorts/cold startup and stochastic generation remain possible variation sources.

## Every question, no task replacement

| ID | DB /public sampling difficulty (withheld) | Cheap | Strong implementation | Routed |
| --- | --- | --- | --- | --- |
|1368 |student_club/simple, original |pass |pass |pass |
|825 |superhero/moderate, original |pass |pass |pass |
|247 |toxicology/challenging, original |fail |fail |fail |
|1323 |student_club/moderate, new |pass |pass |pass |
|1460 |student_club/challenging, new |fail |pass |fail |
|745 |superhero/simple, new |pass |pass |pass |
|744 |superhero/challenging, new |pass |fail |pass |
|248 |toxicology/simple, new |pass |pass |fail after one correction |
|232 |toxicology/moderate, new |pass |pass |pass |
|1411 |student_club/simple, new |pass |pass |pass |

The10cover4simple/3moderate/3challenging and all9DB/difficulty combinations over the3small official DBs. Difficulty/gold/hidden initial SQL grades were never supplied to a worker or selector. Reference7/empty-negative7controls qualified before the extension. Distinct IDs do not guarantee independent semantics or absence from training.

## Actual per-stage routing and review

Routed choices: investigate=scout10/10; implement=worker10/10; review=scout7/10andworker3/10; correction=worker1/1. **worker_strong0/31choices.** Scout and worker are both configured Luna/low with different role prompts/tools; all31routed selections therefore stayed in that configured model/thinking family, despite some role changes. The two configured models are not three distinct model tiers.

Readonly investigation/review offered all3roles but actual SDK tools/scopes allowed only reads. Mutation offered worker/worker_strong only and exactly query.sql mutable; no scout edit. Model stays fixed inside each stage's uncapped SDK loop. Parent owns decomposition, bounded untrusted report handoffs and one possible correction branch. This is stage-level role choice, not per-SDK-turn automatic product model swapping.

All30reviews were valid bounded JSON. Each policy missed2initial official-EX failures. Routed review on248did request one correction, and its separately chosen worker correction completed, but EX stayed false. Thus **one live correction, zero measured accuracy improvements**. A review flag agreeing with a gold-set mismatch is not proof the concrete diagnosis was semantically right. No hidden initial-grade feedback, parent-provided fix, second review/repair loop or failure retry occurred. Initial and final score counts are equal for every cohort/policy.

## Timing, verification and limits

One parent clock perworkflow starts before initial policy choice and ends after all executed stage choices/preparations/handoffs/SDK+file/session/Job/child cleanup and hidden initial/final immutable readonly SQL evaluation. Full wall includes the additional correction/validation when used; it is not just API latency or a concatenation of selected stage times. Human code-review wait0. One-time acquisition/eligibility/initial approval/report serialization remain separate. Stage300seconds/SDKcapnull/query5/evaluator-child10 and all native guards stayed unchanged. The routed vscheap wall gap is **not solely selector overhead**: it includes a correction and stochastic worker variation.

`verify-metadata.mjs` checks4frozen extension hashes,30row/10ID/91stage/31choice/223round consistency, unchanged pilot rows, eligibility/readonly scopes+tools/known cleanup/aggregate score,time,cost with0providers. `verify_local_sql.py` replayed **all30final local query artifacts** against the same frozen metric and matched EX/result/DB digests with0newcalls. Initial pre-correction SQL is not claimed replayed. Public metadata cannot replay SQL without private licensed query artifacts.

Official [BIRD Mini-Dev](https://github.com/bird-bench/mini_dev)/[HF](https://huggingface.co/datasets/birdsql/bird_mini_dev) revisionf65faf4ae3b638c1fa6df1d3370c8d92c8366301, BIRD-SQL team, **CC-BY-SA4.0**. Raw question/evidence/schema/DB/gold/generatedSQL/phase reports and private profile/context/credentials stay local, not MIT-redistributed. Public IDs/hashes/numeric observations are factual provenance only. No private paths/raw provider exceptions/new generated pyc are included; earlier pilot's path-history issue remains separately disclosed and was not force-rewritten.

n=10single-pass questions from3small DBs, post-pilot sample extension, possible semantic/training overlap, low/max thinking plus role-prompt differences, configured aliases/list prices and single-instance unordered/deduplicated set-result EX prevent broad routing/model/security/production claims. This restricted SELECT5smetric is not the full500leaderboard/VES/F1 or a repository coding benchmark. Selector confidence is not calibrated correctness probability; shared direct-SDK selection API does not measure full product approval/lease UX. No post-hoc rubric/test/task tuning was done to force a win.

The closed extension is finished. Product/runtime/dependencies/global profiles/oldACLs/main/v1.0.0tag/releases remain unchanged; evidence commits use[skipci]and start noActions. Metadata and completed budget do not authorize another paid study.
