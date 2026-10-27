# JEV execution layer versus direct SDK: matched follow-up control

**Direct SDK12/12trials completed, compared with the frozen JEV-on12trials.** Both configurations passed6/6task trials and96/96contract groups **in both arms**. On these three synthetic two-module maintenance tasks, the observed data show **no correctness or SDK-round improvement from the JEV execution layer**. This does not prove general equivalence, no value from JEV, or that safety/governance can be removed.

## Correctness, rounds and cost estimates

| Profile / thinking | Arm | All-groups-pass / planned | Passed groups | SDK rounds | Total observed USD estimate |
| --- | --- | --- | --- | --- | --- |
| Luna / low |JEV-on |6/6 |96/96 |29 |$0.02086636 |
| Luna / low |Direct SDK + shared safety |6/6 |96/96 |29 |$0.02073412 |
| Astra / max |JEV-on |6/6 |96/96 |48 |$1.781676 |
| Astra / max |Direct SDK + shared safety |6/6 |96/96 |48 |$1.78180200 |

The direct control used **77SDK rounds**, total estimate **$1.80253612**, compared with77rounds/$1.80254236for JEV-on. These are model-metadata estimates, not account invoices or exact economic equivalence. The tiny observed total-cost difference is not evidence of a systematic saving in either direction. No additional JEV routing/judge calls were made; JEV-on routing calls were already0.

All direct jobs ended naturally with complete validated assistant-usage/count/cost metadata, confirmed file-I/O completion, disposed SDK sessions, confirmed Windows Job/child exit, no retained descendant and no deadline expiry. All workers honestly said tests were not run. The parent reviewed all24generated modules before executing unchanged held-out checks; SPEC/checker hashes stayed unchanged and no extra fixture files appeared. Native/SDK/provider failures, retries, model switches and cwd/profile changes:0.

## Time — different recorded boundaries, not pure overhead

| Profile | JEV native-job median [range] | Direct SDK worker median [range] | Direct parent-owned end-to-end median |
| --- | --- | --- | --- |
| Luna / low |20.0815s [17.119,26.962] |17.6063s [14.4255,19.8623] |18.2009s |
| Astra / max |172.3535s [109.839,201.937] |114.8675s [95.6082,173.9954] |115.4715s |

Do **not** subtract these values and call the result JEV overhead. Historical JEV internal phase timings were not captured, and the direct control ran later rather than interleaving JEV/direct within each pair. Provider queueing, machine/server load, caching and stochastic thinking can differ. Direct startup/generation/parent-owned timings are retained separately in [results.json](results.json); they do not retroactively establish identical boundaries.

## What was removed and what remained shared

Removed from the direct arm: JEV extension loading, public delegation tool, routing/selection/judge, production execution functions, approval packets, execution lease/run protocol and worker/run reducers. The benchmark child called the pinned SDK's `createAgentSession` directly, using the existing explicit model store/auth path and fixed model/thinking. No `jev_delegate`, `executeWorker`, `executeGoalSession`, `executeOrdinaryWorker` or `ordinaryPrompts` invocation occurred.

**Intentionally shared safety code:** file-ID permission/version state, native file-I/O and instruction freshness checks, Windows Job ownership/closure, and sealed Bun startup. This is an execution-layer ablation, **not full absence of JEV-derived code**. Eliminating those guards would change file authority and cleanup guarantees as well as orchestration; that is not the experiment the operator was told we were running. The direct host's closed operator-authorized file-state transition is not a JEV grant/approval record and grants no future authority.

The scoped file tool names, schemas/descriptions/sequential mode, two mutable modules/read-only SPEC, frozen initial/task/test bytes, profile body hash, model/thinking, per-trial300seconds and uncapped SDK counts matched the recorded recipe. No shell/discovery/unrestricted path tools, previous outputs, references or test feedback were granted. Every direct trial began from fresh protected initial files under the same workspace.

## Remaining limitations

- **Ceiling effect:** all models/configurations passed this suite. Two repeats per task and three tasks cannot establish equivalence on harder, larger or exploratory repository work. No post-hoc harder case or task replacement was added to force a winner.
- Current known prompt framing and profile-system hashes matched, but JEV-on historical **full assembled prompt hashes were not retained**. Fresh manifest/instruction paths differ; byte-identical historical prompt equivalence is not proven.
- JEV-on versus direct arms were sequential follow-ups, not randomized/interleaved execution-layer pairs. Within the direct arm, the same registered task/profile/repeat order was preserved. Low/max thinking still differs across profiles; no model-only causal ranking.
- Credential environment variables were stripped from the direct child; the same SDK effect-locally used existing auth/model stores. Private profile/context/auth data and raw provider errors are not published. Configured upstream model identity, account invoices and exact token-price billing were not independently audited.
- Approval UX, routing decisions, independent acceptance, workspace lease contention, parallel orchestration, arbitrary shell safety, large-context recovery, physical UI and general security/maintenance effort were not evaluated. Shared file/Job guards deliberately prevent using this study to claim that no guards are needed without JEV.

## Reproduce recorded code without new paid calls

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json benchmarks/live-model-quality/direct-sdk-control/verify-results.mjs
```

This checks the frozen direct-source manifest, replays the original JEV-on controls/12recorded solutions offline, validates all24direct output-module hashes and repeats the same per-case checks for all12direct outputs. It recomputes round/time/cost summaries from the published projection; it does **not** rerun historical model requests, verify invoices or restore authority. No credentials/runtime source root are needed for this offline reproduction. Trusted checked-in JavaScript executes under the caller's OS user, not a sandbox.

Direct sources/method were committed at e0b09f1bf3052138f2820711702eade781ebd942 before the first provider request. All10zero-provider guard/Job/mock-wiring/accounting tests and two actual SDK-session-without-prompt preflights passed first. An ESM import mismatch and cancellation-unit receipt expectation were corrected in the unpaid preparation stage; no paid attempt was silently retried. The frozen JEV-on results remain unchanged at d12aae0f7b9172d08a7d202961b0bc431bfe5a6f.

No product runtime/dependency/profile change, old ACL repair, runtime installation, new release/tag, main merge or GitHub Actions execution was performed. Evidence-only commits use `[skip ci]`; no product release gate is waived. The operator-authorized12-trial direct batch is finished; this data is not a standing grant for additional paid work.
