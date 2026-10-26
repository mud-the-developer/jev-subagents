# Arch Linux development handoff

## Resume point and scope

This is a development/evidence handoff, not a release, execution grant or Linux certification. Development is paused after the reference-grounded benchmark audit. No new paid benchmark, package/runtime installation, main merge, tag/release or CI dispatch was performed for this handoff.

| Item | Verified state before this handoff commit |
| --- | --- |
| Repository | https://github.com/mud-the-developer/jev-subagents |
| Resume branch | `bench/live-profile-quality-pilot` |
| Last evidence commit | `5f8e634e9969f45e3b9c574c527e1293acc5581d` |
| Open evidence PR | https://github.com/mud-the-developer/jev-subagents/pull/1 |
| Main / peeled v1.0.0 tag | `36cc17c2e21e66f863a0b308fb177ff01536587c` |
| Package | `jev-subagents`1.0.0, `private:true`, no npm publication |
| Existing worker pins | standalone Bun1.4.3; Pi SDK0.85.1; TypeBox1.3.7; SDK-scoped undici8.12.2 |

The branch HEAD after this document is the resume point; do not reset an existing checkout to the older evidence commit. Main and the immutable release remain separate. Existing source/script/test files are in Git; machine-local dependencies/auth/session state are not a portable installation.

## Fresh checkout, without overwriting another workspace

Use a normal user, a fresh user-owned directory and existing Git authentication. Choose another directory name if the example already exists; do not reset/clean/force-checkout or repair ownership/permissions on an old workspace.

```bash
umask 077
git clone --branch bench/live-profile-quality-pilot --single-branch \
  https://github.com/mud-the-developer/jev-subagents.git jev-subagents-dev
cd jev-subagents-dev
git status --short --branch
git log -1 --oneline
```

Read [installation](installation.md), [verification](verification.md), [security](security.md) and [usage](usage.md) before registering a development copy. Do not register two JEV copies or assume that installing this branch replaces the stable release.

## First Arch checks: offline and keyless

1. Verify **existing** standalone `bun --version` is exactly1.4.3, and inspect `command -v bun`/its resolved directory. Stop on a missing or different runtime; installation/upgrade is a separate explicit action. No Node fallback or silent SDK upgrade.
2. The POSIX Bun-only gate requires the Bun executable's directory to have **no Node/npm/npx siblings**. A system `/usr/bin` installation beside Node can fail this requirement. Do not delete system Node, change global PATH, disguise a runtime or weaken the gate; select an explicitly prepared existing standalone Bun directory.
3. Ensure existing `git,bash,sh,env,make,tar,unzip` are available; `scripts/check-bun-only.ts` checks them. Do not install missing tools implicitly.
4. Prepare full frozen development dependencies and run the existing CI-style POSIX gate:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json install --frozen-lockfile --ignore-scripts
bun --no-env-file --no-install --config=src/worker-bunfig.toml run check:bun-only
```

The install can download pinned dependencies; it is not a runtime/model installation. `check:bun-only` builds an isolated keyless HOME/PATH, traps Node/npm/npx CLI attempts, and runs `check` plus the owned loopback demo. Its synthetic/local model calls are not paid-provider evidence. Keep failure logs and inspect them before a new run; do not automatically retry or change limits. Preserve normal30-second test deadlines and four-file parallelism. The existing historical Windows Goal-boundary catalog's separate50-second setting is not a new Linux test default and must not be used to evade failures.

This Windows handoff did **not** run the gate on Arch. Existing Linux CI and native Windows evidence are not proof that a new Arch checkout passes. Generated `src/*worker.probe-*`, node_modules and caches must be rebuilt/verified on the target, not copied from Windows or committed.

### Reproduce the audit without starting a model

The audit used existing Python3.14.8 standard library; no SciPy/statsmodels install is required. The metadata-only analyzer needs neither Bun dependencies, private query fixtures nor provider credentials. Use the existing Python and record its version; do not upgrade automatically.

```bash
python -I -S -B benchmarks/selection-policy/reference-audit-v1/analyze.py --self-test
audit_output="$(mktemp "${TMPDIR:-/tmp}/jev-reference-audit.XXXXXX.json")"
python -I -S -B benchmarks/selection-policy/reference-audit-v1/analyze.py --output "$audit_output"
printf 'Audit replay saved to %s\n' "$audit_output"
```

Write the replay to a new temporary file, not over the published report snapshot. Its host/Docker-availability fields legitimately change on Arch; compare the numerical analysis separately. The historical input SHA is pinned to `714f847dc3e3b4e3586df49d70405cbcfcf91498b4417f4c4c26f5fe4e0151ff`. Source/result manifests use LF bytes; Git-blob hashes were verified. Preserve LF when generating JSON on another OS.

## What is measured, and the correction that must survive migration

Start with [reference audit RESULTS](../benchmarks/selection-policy/reference-audit-v1/RESULTS.md), [primary references](../benchmarks/selection-policy/reference-audit-v1/REFERENCES.md) and [next-run measurement contract](../benchmarks/selection-policy/reference-audit-v1/METHOD.md).

- Historical10-question/30-workflow multistage results remain strict EX8/10cheap,8/10strong,7/10routed; full wall sums364.34/600.95/391.76seconds.91workers/223SDK rounds/31actual JEV choices are **not223independent trials**. See [immutable ten-question evidence](../benchmarks/selection-policy/multistage-bird-extended/RESULTS.md).
- The completed audit made0new provider/model calls. Routed-vs-cheap exact paired McNemar p=1.0; mean wall difference+2.7419s/task has conditional95%paired-task percentile interval[−0.4370,+6.6717]s. Neither regression nor equivalence/general semantic quality is established.
- PGR is undefined because the two fixed-workflow strict-EX baselines tie at0.8. No APGR/CPT can be invented from one uncalibrated confidence point. The ex-post fixed-workflow bank's random expectation8/10and oracle9/10are diagnostics, not live routing/cost/latency results or official RouterBench scores.
- Cases247/248/744/1460 have verified gold/evidence or output-projection/direction-contract issues. The official strict-EX numbers stay intact; **do not describe7/10as semantic answer quality70%, repair/drop old cases or manufacture a post-hoc10/10score**. Gold SQL executing/nonempty is not semantic QA.
- Scout and worker used the same configured Luna/low model with different role prompts/tools; worker_strong used Astra/max. Historical routing chose no strong role. Names/choice confidence are not calibrated correctness probabilities or upstream identity audits.
- The custom benchmark used mandatory investigation/implementation/review and an optional one-correction branch. It is a route-API/direct-SDK experiment, not the complete native product approval/lease UX or a production per-SDK-turn model-switching feature. Extra time mixes selection, one correction, preparation/model variability and external oracle grading.

A valid next live study needs explicit output/gold contracts and independent graders, separate calibration/held-out tests, matched cheap/strong/random/oracle controls, prespecified repeated paired trials, separate workflow/oracle clocks and complete token/cache/cost/failure accounting. Do not tune these against the old test answers and then present the same10as a fresh win.

## Portability: product support is not benchmark-runner support

- Product code has POSIX ownership/process-group paths in `src/goal-run-effects.ts`, plus shared runtime policy in `src/worker-runtime.ts`. Validate actual Arch behavior with the existing tests; this document does not extend support claims for retired Goal/sequence/container/SoL-Pi features.
- **The historical live benchmark runner is Windows-only:** `benchmarks/live-model-quality/direct-sdk-control/owned-run.mjs` asserts `process.platform === "win32"` and owns a Windows Job before releasing the worker payload. The later BIRD runners reuse it and a Windows-specific existing Python-location check. They are not ready-to-run Arch scripts.
- Do not spoof `process.platform`, delete the assertion, drop Job ownership or reuse a Windows helper as a POSIX certificate. A future port must be separately versioned and reuse the project's actual POSIX ownership/cancellation/process-group cleanup, fresh file/context identity and SDK accounting checks. Preserve old frozen sources/manifests/results instead of rewriting their history.
- Frozen Windows profile hashes, paths, context versions, leases, journal/lock identities and approvals are not Linux grants. Never restore a previous Full Access grant/receipt/lock to start a new job. Reconfigure and verify model authentication/JEV backend separately through the normal existing local workflow; do not commit or paste credentials.
- The previous host had no Docker executable. Arch may differ, so inspect it rather than inheriting that observation. Canonical SWE-bench needs an existing approved Docker repository/test environment; no install, daemon start, cloud job or new CI run is authorized by this handoff. SQL results are not a coding score.

## Private/local material intentionally not in Git

Do not add `.pi` authentication/config, real profile bodies, model/provider logs, raw phase reports, private payloads, locks/leases/journals, node_modules, probe executables, caches or generated bytecode. Existing local patches/checkouts must be preserved; all inspected project worktrees were clean before this handoff.

Raw CC-BY-SA4.0 BIRD questions/evidence/schema/databases/gold/generated SQL and historical private query fixtures are not MIT-redistributed. Provenance and acquisition hashes are in the benchmark folders; reacquire licensed data into a fresh private target directory if needed. Old **model-generated** query artifacts cannot be regenerated from hashes without another separately authorized model run. Metadata/source/statistics are portable; reproducing historical SQL needs an explicit secure out-of-Git transfer of the required artifacts, excluding credentials/authority state, or must be reported unavailable.

The earlier accidentally committed generated `.pyc` containing an absolute source filename was removed from current HEAD before live multistage work, but its old commit still exists. No key/DB value was in that artifact. Do not claim clean history or silently force-rewrite it during migration; see the prior audit documentation.

## Suggested next bounded work, not automatic execution

1. Clone the resume branch and verify source/runtime/dependencies; run keyless POSIX and metadata-only gates, retaining genuine failures.
2. Decide whether the next objective is routing-component quality/cost, scaffold overhead, or canonical repository coding ability. Use the reference-backed contract rather than conflating those questions.
3. If live-run portability is required, implement and test a separate POSIX benchmark executor adapter with preserved ownership/cancel/accounting semantics before paid work; leave historical Windows evidence frozen.
4. Only after grader/contracts, held-out/calibration data, repeated-trial budget, exact candidates/settings and supported execution environment are fixed should another paid study be explicitly authorized. Do not automatically resume the completed batches.

Stable main/release remain untouched. This document records a handoff and the limits of the evidence, not approval for any of the suggested future actions.
