<div align="center">

# jev-subagents

**Route when needed. Review the exact scope. Follow every worker.**

JEV-assisted subagents for [Pi](https://pi.dev), with native terminal plans, explicit worker permissions and bounded reference sharing.

[**Download v1.0.0**](https://github.com/mud-the-developer/jev-subagents/releases/tag/v1.0.0) · [Installation](docs/installation.md) · [Usage](docs/usage.md) · [Security](docs/security.md)

</div>

[![Source checks](https://github.com/mud-the-developer/jev-subagents/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/mud-the-developer/jev-subagents/actions/workflows/check.yml)

**Stable source release: `v1.0.0`.** This release covers the documented bounded execution and verification contracts, not a claim of general task correctness, physical TUI certification or real-provider quality/billing. Runtime source, scripts and all regression tests are preserved in this public snapshot; private development history, personal-path reports and internal screenshots are not distributed.

**Development resume (Arch Linux):** use the [Arch Linux handoff](docs/ARCH-LINUX-HANDOFF.md) for the current evidence branch, pinned setup/offline checks, benchmark interpretation corrections and Windows-only runner limitations. It is not a new release or a Linux certification.

**Security notice:** the immutable RC1 ZIP still contains `undici8.10.2`, affected by newly published advisories. `v1.0.0` pins the SDK-scoped dependency to `8.12.2`; the original RC1 tag and assets are not retroactively patched. See [security status](docs/security.md#dependency-security-status).

## See each model's job in a three-level tree

**Included in v1.0.0:** human-only English task labels and the three-level dependency view below. The immutable RC1 ZIP does not include these later UI updates.

<p align="center">
  <a href="docs/media/workflow.gif"><img src="docs/media/workflow.gif" alt="Synthetic three-level native task tree: scout inspects the approved module, worker performs a file-ID edit, reviewer checks the changes, and every model has an English one-line task description before an unverified ending." width="1120"></a>
</p>

**Real component output, synthetic scenario.** This GIF is an offline-rendered UI preview, **not a screen recording, live task, approval receipt or performance benchmark**. Model names, SDK counters and timing are illustrative. Indentation represents task dependencies, not recursive delegation or extra workers. [Static preview](docs/media/task-tree.png) · [Capture method and provenance](docs/media/README.md).

| Review before execution | Know what an ending means |
| --- | --- |
| [![Native exact-source review viewport with synthetic model, tools and runtime, never submitted](docs/media/source-review.png)](docs/media/source-review.png) | [![Native task tree ending with all workers explicitly completed but unverified and human review still required](docs/media/ended-unverified.png)](docs/media/ended-unverified.png) |
| One complete native source review; scroll through the full packet. This example is an ordinary-profile review, not the file-ID tree's own packet. | Completion stays **unverified**. The UI does not turn a finished process into passed verification or task acceptance. |

*Click a still image to view it at full resolution. Prefer less motion? Use the [static task-tree image](docs/media/task-tree.png).*

| Explicit roles | Visible dependencies | Clear boundaries |
| --- | --- | --- |
| Fixed profiles and optional JEV candidate advice | Read lanes can overlap; dependent mutations wait | Reviewed scope, owned cleanup and no automatic retry |

## Install from GitHub Releases

Download **`jev-subagents-1.0.0-source.zip`** and **`SHA256SUMS`** from the [release page](https://github.com/mud-the-developer/jev-subagents/releases/tag/v1.0.0). Use the named source asset, not an unpinned branch or a GitHub-generated archive of a different commit.

1. Verify the archive SHA-256 against `SHA256SUMS` from the official release.
2. Extract into a new stable local folder outside `node_modules`. On Windows use a normal non-admin account and local fixed NTFS with safe ownership/ACLs. Do not repair permissions or overwrite an existing installation.
3. In the extracted `jev-subagents-1.0.0` folder, prepare the frozen production dependencies and register the local source:

   ```text
   bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json install --production --frozen-lockfile --ignore-scripts
   pi install <absolute-extracted-folder>
   ```

4. Reload Pi, or restart it, then use **`/jev-subagents`**. Do not register both an old and a new copy. Existing authentication/profiles should be preserved; create or change profiles only through a separate explicit action.

**No npm publication.** `private: true` stays set. Bun may still download pinned dependencies from the public npm registry; dependencies, Bun, Pi and user credentials are not bundled. See [installation and upgrades](docs/installation.md).

## Requirements

- An existing Pi installation and standalone **Bun 1.4.3**. No automatic runtime upgrade or Node fallback.
- Workers use pinned **Pi SDK 0.85.1 / TypeBox 1.3.7**. A Node-hosted Pi may have its own host requirements.
- Linux and normal-user native Windows are the intended runtime targets. Windows requires PowerShell/Add-Type, local fixed NTFS and the existing Job/SID/DACL/file-identity checks. Elevated Windows execution is refused.
- Worker model authentication and permission templates are prepared separately. Automatic execution selects actual available provider/model and canonical supported thinking from the offline worker catalog using reviewed current-task code/state, not profile model headers. Availability is not quota or inference proof. Explicit fixed-profile requests remain supported; JEV decision backends are separate.

## Commands and tools

The command is **`/jev-subagents`**; `/jev` is not registered.

```text
/jev-subagents help
/jev-subagents status
/jev-subagents runtime
/jev-subagents doctor
/jev-subagents profiles
```

`profiles` can create missing recommended user profiles only after exact-source approval; it does not overwrite existing files. Setup selection and diagnostics are not execution approval. Read [usage](docs/usage.md) before starting a real worker.

| Tool | Purpose |
| --- | --- |
| `jev_route` | Recommend among explicit candidates; no execution authority |
| `jev_decide` | Bounded option advice; mandatory human approvals stay human |
| `jev_delegate` | Prefer `auto` for context-aware available-model/thinking selection; explicit fixed scopes remain available |
| `jev_memory` | Explicit parent-only SQLite memory administration |

Single workers, sequential scoped jobs, dependency trees, read-only fanout and bounded parent/child reference sharing use the existing source-approval and ownership contracts. A task tree executes at most three workers total; read lanes may overlap, but scoped mutations remain exclusive. There is no automatic retry, model/provider fallback or restored execution authority.

### Automatic model selection

Native `/jev-subagents run` defaults to automatic selection. The parent can use `jev_delegate({auto:{task,files,constraints?,observations?,role?}})`; users need not prepare candidate lists. Roles control tools, not models. The automatic catalog is bounded to128models and their canonical supported thinking levels (at most7per model /896eligible pairs). The public TypeSafe choice schema allows255criteria per question, so routing first selects a model (at most128criteria), then only its supported thinking (at most7criteria), using at most2dependent requests. It fails rather than truncating. The older explicit fixed-profile pool retains its128-plan bound. A unique combination bypasses JEV, not execution approval.

| Selection state | Event | Next state / effect |
| --- | --- | --- |
| idle | Valid task context and catalog | reviewing / exact context+catalog source review |
| reviewing | Genuine positive review of the conditional two-request plan | selecting_model / one model choice, or singleton-model bypass |
| reviewing | Decline or cancellation | stopped / no routing or worker |
| selecting_model | Eligible model recommendation | selecting_thinking / only this model's supported levels; support<0.5 marks explicit human worker review as mandatory |
| selecting_thinking | Eligible supported level recommendation | selected / pin provider, model, thinking and target; retain weak support without authorizing execution |
| either selection stage | Invalid, failed or cancelled result | stopped / no replacement model, re-selection or retry |
| selected | Scoped execution requested | existing freshness/ownership checks; any weak model/thinking recommendation forces genuine explicit worker review, even in Full Access |

Current-task context includes approved existing-file content, constraints and relevant observations, not ambient conversation or auth. The source disclosure gets its native review even in Full Access; Reviewed execution separately reviews the actual selected worker. Explicit `modelSelection:"fixed"` on native `run` retains the profile model. Existing explicit `scope`, `graph`, `tree` and legacy fixed-profile requests retain their original contracts; this does not silently replace models inside an already approved multi-stage job. See [usage](docs/usage.md).

## Safety and cost

Reviewed is the default. Explicit `/jev-subagents access full` grants temporary session delegation authority only after a risk acknowledgement; it is not administrator access and does not cover installation, profile creation, standalone memory administration or other extensions. Revocation/navigation/reload invalidates it.

Ordinary profiles can use files and shell capabilities available to your OS user when their tools allow them. This is **not an OS sandbox or rollback**. Restricted file-ID jobs and read-only profiles retain their narrower guards. Do not supply secrets or unreviewed sensitive source. Model calls can incur charges; SDK natural completion is not a token/dollar cap, and Full Access has no cumulative session spending cap.

Completion is unverified until the declared checks and human review say otherwise. JEV advice is neither permission nor proof. Unknown ownership/accounting/cleanup retains locks and blocks new work; do not delete them to force a retry. See [security and limits](docs/security.md).

## Verification and source provenance

Use the exact release commit and [existing validation commands](docs/verification.md). The release notes record the actual observed gates; they do not certify physical UI interaction, live-provider billing or arbitrary tasks. The public snapshot keeps all runtime/script/test files byte-identical to the reviewed development snapshot; only version metadata and public documentation/distribution inputs differ. See [RELEASE-SOURCE.json](RELEASE-SOURCE.json).

**Additional live-profile evidence:** the [integer-ranges pilot](benchmarks/live-model-quality/integer-ranges-v1/README.md) compares an original buggy negative control with one real Luna/low and one real Astra/max repair, using the same held-out assertions and seeded oracle. Both recorded outputs passed12/12contract groups and1000/1000oracle cases; thinking differs and n=1per profile, so this is not a general model ranking or billing certificate. The checked-in evidence can be reproduced offline with0new provider calls; it is newer than the immutable v1.0.0 release ZIP.

**Completed registered comparison:** [multi-module suite v2](benchmarks/live-model-quality/suite-v2/RESULTS.md) used three task specs,48contract groups, positive/negative/mutant controls and a fixed counterbalanced12-trial order. Both operational profiles passed6/6task trials (96/96groups), so this suite showed no correctness separation. SDK round counts were uncapped by operator request; time bounds remained300seconds. Full per-trial code/hashes/checks and offline reproduction are included, with thinking/load/sample-size/billing limitations stated explicitly.

**Direct SDK follow-up control:** the [matched execution-layer ablation](benchmarks/live-model-quality/direct-sdk-control/RESULTS.md) also passed6/6task trials per profile, with the same29/48SDK-round totals as JEV-on. No correctness/round-count benefit from JEV was observed on this suite. Safety utilities were deliberately shared, and full historical prompt/timing-boundary equivalence was not proven; this is not evidence that all JEV-derived code/guards can be removed or a general superiority claim.

**Actual selector / end-to-end follow-up:** the [official BIRD Mini-Dev subset pilot](benchmarks/selection-policy/bird-mini-dev-pilot/RESULTS.md) measured one continuous parent clock from policy choice through validation/cleanup on6public SQL tasks ×3policies. Luna3/6EX/65.96s, Astra5/6/160.55s, JEV-selected3/6/66.40s (all6choices Luna): no observed benefit over always-Luna and no preserved-Astra-accuracy speedup. Data license, sampling, hashes, per-phase metadata and small-sample/metric/privacy limits are explicit; raw CC-BY-SA dataset/SQL is not relicensed under MIT.

**Per-stage role-routing follow-up:** the [multistage fresh-holdout pilot](benchmarks/selection-policy/multistage-bird-pilot/RESULTS.md) used investigation ->implementation ->read-only review, with one bounded correction only if requested. Across9matched workflows/27worker stages, all policies scored2/3EX. JEV's9actual choices always yielded scout ->worker ->scout; the reviewer missed the failing query and no correction activated. This changes the benchmark workflow, not per-SDK-turn product model switching, and provides no observed gain over the fixed cheap role path on these3holdouts.

**Extended to ten questions:** the [sequential multistage extension](benchmarks/selection-policy/multistage-bird-extended/RESULTS.md) retained the3pilot cases and added7new holdouts under unchanged prompts/scoring/safety. Across30workflows/91worker stages, fixed cheap8/10EX/364.34s, fixed strong implementation8/10/600.95s, routed7/10/391.76s. JEV made31stage choices but never selected worker_strong; one correction did not improve EX. These observational/small-sample and post-pilot-extension limits are explicit; there is still no observed gain over the cheap matched control.

**Reference-grounded interpretation correction:** the [primary-source audit](benchmarks/selection-policy/reference-audit-v1/RESULTS.md) keeps all historical EX/timing/cost records intact but documents output-contract/gold inconsistencies: strict8/8/7EX is not semantic answer accuracy or proof of product-harness regression. The executed zero-provider paired analysis gives McNemar p=1.0for routed vscheap; task-bootstrap mean-time difference+2.74s has95%interval[−0.44,+6.67]s. PGR is undefined when fixed-workflow quality baselines tie, and a replayed oracle is only a diagnostic. Nine primary references, reproducible code and gates for a valid next study are linked; no new live/canonical coding score is claimed because the required Docker environment is absent.

Retired Goal/sequence/managed-context/SoL-Pi integration code and small historical fixtures remain solely for regression coverage; they are not additional public tool APIs or current execution instructions. The two historical diagrams are [archived with their editable sources](docs/figures/README.md), not advertised as current features. Standalone SoL-Pi remains separate.

## License

Original project work is licensed under [MIT](LICENSE). Preserve the [third-party notices](THIRD_PARTY_NOTICES.md), including the unmodified NVIDIA MIT notice on the pinned regression fixture. Dependencies retain their own licenses.
