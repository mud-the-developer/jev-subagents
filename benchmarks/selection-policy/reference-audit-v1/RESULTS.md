# Reference-grounded reanalysis: what the existing pilot can and cannot establish

**Actually executed:** deterministic statistical/source audit of the existing10paired tasks/30workflows, plus12bounded local contract diagnostics. **0new model/provider calls.** This is not a new held-out agent run, a repaired semantic score or a canonical coding evaluation. Original strict EX remains8/10cheap,8/10strong,7/10routed. Primary sources and their limits are linked in [REFERENCES.md](REFERENCES.md); requirements for a valid next run are in [METHOD.md](METHOD.md).

## 1. Preserve the metric and retract the overinterpretation

The official BIRD evaluator checks row-set equality, not universal semantic truth.[R4] The historical adapter additionally restricts SELECT/query time/result bounds. Its numeric EX observations are reproducible, but interpreting7/10as “semantic answer quality70%” or proof of product-harness failure was unjustified.

The reproducible private-data checks in `audit_contracts.py`/`contract-audit.json` confirm:
-247: all3predictions match the provided atom-ID evidence rule; the gold instead excludes globally bonded element types and returns a different set.
-1460: cheap/routed concatenate the same gold first/last names and return the same cost, but their2-column projection differs from the3-column gold shape.
-744: strong returns the correct difference **and** the winning publisher requested by the question; the gold contains only a scalar difference.
-248: routed final output contains extra columns and deduplicated undirected endpoint pairs matching the gold bond facts, rather than the gold's directed2-column representation.

These cover all4distinct failing IDs but are **post-hoc case-specific diagnostics, not a new10/10semantic metric**. Do not remove cases, alter old gold, aggregate a corrected score or feed hidden gold to agents. Reference execution/nonempty negative controls did not establish task/gold semantic agreement. Test-suite semantic evaluation is a different method and does not fix an inconsistent gold oracle automatically.[R3], [R4], [R5]

## 2. Paired uncertainty, not unqualified ranking

Each task/policy has **one trial**, not223independent trials. SDK round counts are interactions, not replications.[R3] On the recorded strict-EX flags:

| Candidate minus reference | Mean EX difference | Paired task bootstrap95%percentile CI | Exact paired McNemar p |
| --- | --- | --- | --- |
| Routed minus cheap |−0.10 |[−0.30,0.00] |1.0 |
| Routed minus strong |−0.10 |[−0.40,+0.20] |1.0 |
| Strong minus cheap |0.00 |[−0.30,+0.30] |1.0 |

Routed versus cheap has only **one discordant task**(248): cheap passes and routed fails. This does not establish a statistically reliable quality regression, equivalence or semantic conclusion. Tests and intervals are exploratory/nominal, not multiplicity-adjusted confirmatory claims.[R7,R8]

| Routed minus cheap metric, per task | Recorded mean difference | Paired task95%percentile CI |
| --- | --- | --- |
| Workflow wall |+2.7419s |[−0.4370,+6.6717]s |
| Cost estimate |+$0.00007215 |[−$0.00044573,+$0.00063900] |

10000paired task resamples, seed0x6A09E667, standard-library percentile implementation; shared indices preserve task pairing.[R9] These intervals condition on the single recorded trial for each policy/task. They do not measure within-task generation variance, a production tail-latency SLA or causal effect of routing. A good interval cannot repair an invalid output contract.

## 3. Apply routing metrics only where defined

RouteLLM evaluates joint quality/call-cost curves, with strong/weak/random controls—not “uses the expensive model less, therefore wins.” Its PGR divides by strong-minus-weak quality, and APGR/CPT depend on an appropriate threshold/call-performance sweep.[R1]

Here both fixed-workflow strict-EX means are0.8. Consequently **PGR is undefined**(zero denominator), not0and not a perfect score. APGR/CPT are also unavailable: no nonzero baseline gap, calibrated held-out threshold sweep or justified conversion from JEV's choice confidence to task-success probability. These are whole role workflows, not the paper's canonical binary-model response setup.

Absolute quality/cost comparison remains meaningful as a limited observation. Strong-call share0alone is not a failure when always-cheap already reaches the same aggregate score; candidate complementarity may still allow improvement, but it must be demonstrated on valid held-out outcomes rather than assumed from profile names.

## 4. Offline bank checks are upper bounds, not new live measurements

Inspired by recorded-outcome comparisons in RouterBench[R2], enumerate all1024cheap/strong **fixed-workflow** choices for the10tasks:

| Recorded-bank diagnostic | Strict EX | Recorded total cost estimate |
| --- | --- | --- |
| Always cheap |8/10 |$0.04338148 |
| Always strong |8/10 |$0.92429248 |
| Independent50/50mixture, exact expectation |8/10 |$0.48383698 |
| Ex-post gold oracle, cheapest tie |9/10 |$0.14267188 |

The oracle chooses strong only for1460. It is a test-label-aware non-deployable upper bound; it still misses247under the questionable original gold. Random correct-count probabilities are7/10:25%,8/10:50%,9/10:25% over this fixed bank.

**No new model runs, service charges or oracle/random wall times were measured.** This is not an official RouterBench score and not faithful replay of the actual history-dependent routed stages. Actual routed runs generated different analysis/query/review samples and included one correction. Do not call the bank's9/10a live policy win or its gap against7/10causal routing regret.

## 5. Show where the existing time and cost went

| Recorded wall component | Fixed cheap | Routed |
| --- | --- | --- |
| Selector phase (includes imports/parse, not pure remote inference) |0.0006s |5.7223s |
| Parent stage preparation/persistence |37.4961s |43.8695s |
| Owned-process envelope outside child timer |17.1855s |18.6272s |
| Child session/tools/freshness/cleanup |300.7676s |314.2694s |
| Hidden initial+final oracle grading |8.8779s |9.2568s |
| Other outer bookkeeping |0.0165s |0.0179s |
| Total |364.3441s |391.7630s |

These top-level components are disjoint. Child startup/generation are nested diagnostics; generation also includes tool/freshness/cleanup, and SDK import occurs outside the child timer. The process envelope mixes import/IPC/Job/exit; it does not isolate native security overhead. No failure/retry/cleanup defect was observed. Do not disable or cache SID/DACL/file-identity/context-freshness/cancellation/Job checks to make a speed claim.

The+27.4189srecorded gap comprises+5.7217sselector-phase difference,+14.2210sadditional correction excluding its own selector, and+7.4762sother recorded differences. The latter mixes preparation/model/tool/SQL variability, not a proven specific bottleneck. Initial/final oracle grading runs even when the candidate is unchanged; q247's~3.4squeries dominate that grading tax. That is benchmark work, not automatically production agent latency.

Cheap investigation+review phases alone consumed228.7830s(~62.8%of total) and~62.4%of worker cost. Three fresh sessions and report-reading loops were mandatory; the selector could not choose to skip them. Without a same-task one-step ablation, this does not establish that multistage is better or worse, but it exposes a substantial design cost.[R3]

Routed total estimate$0.044102956minus cheap$0.04338148is **+$0.000721476(+1.66%)**. Recorded selector cost is$0.000725676; total worker costs are nearly identical. The strong arm's high cost is mostly its implementation stage($0.89728of$0.92429), not a JEV/native-process invoice. Token/cache breakdown and actual billing are unavailable.

## 6. Which harness needs attention first?

The demonstrated gaps are in the **custom benchmark adapter**, especially `run-workflow.mjs` task/grader contract, generic `choose` input, mandatory stage structure and mixed oracle/workflow clock. The selector sees question/evidence/phase but not relevant schema/current query/review issue or actual model/price evidence. Scout and worker share the same configured Luna/low tier; role changes are not evidence of model-quality escalation.

This adapter calls a routing API plus shared direct SDK execution. It is **not the complete native product approval/lease/task harness**, and the data do not establish that Pi/Bun/Windows Job safeguards are broken. Keep security boundaries and old scores intact. Priorities for a new study are: independently valid task/gold/output contracts; sufficient approved router inputs; matched routing and scaffold ablations; repeated paired held-out trials; explicit operational versus external-grade clocks and cost fields.[R1]–[R4], [R6]–[R9]

## 7. New canonical coding benchmark: explicitly not executed

SWE-bench's official approach applies patches to real repositories and evaluates repository tests in Docker.[R6] This Windows host has **no Docker executable**. No runtime installation, WSL start/elevation or remote/cloud job was authorized or started. Therefore this audit reports no SWE-bench score and does not substitute SQL/MCQ performance for coding ability.

The deliverable here is executed, referenced analysis plus an explicit next-run measurement contract—not another defective-gold paid rerun. Existing EX/prompts/security/clock definitions/files remain unchanged. See `report.json`, `contract-audit.json`, `analyze.py` self-tests and the reproduction commands in [README.md](README.md).

[R1]: https://arxiv.org/html/2406.18665v4
[R2]: https://arxiv.org/html/2403.12031v2
[R3]: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
[R4]: https://github.com/bird-bench/mini_dev/blob/abd11b6db92a1c9f809b32f7564c7c71b34d67f0/evaluation/evaluation_ex.py
[R5]: https://aclanthology.org/2020.emnlp-main.29/
[R6]: https://www.swebench.com/SWE-bench/guides/evaluation/
[R7]: https://aclanthology.org/P18-1128/
[R8]: https://www.statsmodels.org/stable/generated/statsmodels.stats.contingency_tables.mcnemar.html
[R9]: https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html
