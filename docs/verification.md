# Verification and supported claims

Use existing standalone Bun1.4.3 and the trusted flags below. Tests use isolated/keyless profiles, synthetic approvals and anonymous loopback model fixtures; they do not use real-provider credentials or grant live execution authority.

## Source checks

For a source checkout with full frozen dependencies (not a production-only install):

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json install --frozen-lockfile --ignore-scripts
bun --no-env-file --no-install --config=src/worker-bunfig.toml run check
```

The existing Linux/macOS CI gate uses `check:bun-only`, which also traps Node/npm/npx CLI attempts and executes the owned offline demo. A compatible Node API import does not imply dependence on a Node executable. The workflow pins Bun and action revisions; no test was removed from the public snapshot.

## Native Windows

Use a normal non-admin account and a new local fixed-NTFS folder with existing safe ownership/ACLs, plus a standalone Bun1.4.3 folder without Node/npm siblings. Do not elevate, repair ACLs, reset/clean another checkout or change global PATH.

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml run check:windows-native
```

The gate checks actor/source/home safety, builds a keyless child environment without Node CLI paths, runs lint/typecheck/the existing Windows test catalog and then `demo:job`. It retains command exit/signal/error code, source commit, manifest/lock hashes and child log paths. Inspect logs before any new run; failure is not permission to increase limits or weaken guards. Four-file parallelism and30-second normal test deadlines are unchanged. The separate historical Goal boundary retains its existing50-second catalog only.

Hosted Windows CI runners are elevated, so their lint/typecheck job is not a substitute for this native non-admin process/filesystem acceptance.

## Installed Pi1.3 UI surface — v1.0.0

The updated opt-in probe is included in v1.0.0 and is newer than the immutable RC1 ZIP. It requires an **existing Pi1.3.0 SDK directory** and the source checkout's frozen full dependencies; it does not install or adopt another host SDK:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json test/host-tui-surface.mjs "/absolute/path/to/existing-pi-1.3.0-package" "receipt.json"
```

This uses the installed host loader, native editor/renderer and a private test-only review bridge. Synthetic input checks complete literal source, untimed review waiting, positive submission, cancellation and edited-source denial; cards cover English three-level model/task lines at48/80/120columns. It also checks the separate standalone fixture, unchanged configuration and tool metadata limits. The receipt records the probe engine, host/worker SDK versions, zero network/worker calls and synthetic limitations. A positive synthetic review is never a live job grant or physical operator acceptance.

## Automatic selection and native RPC checks

Automatic model/thinking routing uses the same SystemOne `choice` question with explicit `instructions` as existing advice. The public [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json) declares `ChoiceQuestion.criteria.maxProperties:255`; the bounded offline contract excerpt is `test/fixtures/typesafe-choice-contract.json`. A conditional plan selects at most128models, then only the chosen model's at most7supported thinking levels. It makes at most2dependent requests, never one oversized Cartesian question or two independent answers. A loopback fixture verifies both HTTP envelopes and the selected-model dependency; parser-only or mocked-return success does not establish provider acceptance. Human review may losslessly group every candidate ID by model and effort while the original immutable routing packet stays unchanged. Tests expand the projection back to all original candidates, including prices, context windows, source, role and target.

RPC supports genuine native confirmation requests and literal responses. A client must display the complete trusted review and forward the actual operator's response for that live request ID; it must never auto-approve, invent a receipt, replay an old ID or infer Full Access. The RPC startup selector is scheduled after `session_start` returns because the host installs its stdin reader after binding extensions. Lifecycle cancellation consumes queued setup. A read-only RPC state/command response while the selector is pending verifies input readiness, not execution authority.

Routing failures retain only finite HTTP/status, timeout, transport, response-bound or invalid-response categories. Automatic choice parsing additionally records one of four finite validation codes: `choice_fields`, `distribution_fields`, `distribution_total` or `choice_not_maximum`. These identify the failed validation, not a provider root cause; unknown exceptions remain unclassified. A `distribution_total` failure also retains only its bounded numeric total, applied tolerance and candidate count, without the response map. These observations neither relax validation nor reconstruct older unrecorded totals. Raw provider bodies and exceptions stay withheld. Fetch attempts, pending usage receipts and unknown total cost are distinct from worker SDK calls. Missing usage is not zero cost, even after an HTTP error. Weak but valid routing retains its approved model/effort and uncalibrated support as recommendation-only metadata with `executionAuthorized:false`; the existing0.5threshold marks explicit human worker review as mandatory rather than silently rejecting the eligible recommendation. Both weak stages are retained, and Full Access cannot bypass that review. Until an actual positive native reply, the recommendation authorizes no worker execution. This is not a quality score, a task-success probability or an execution grant. Failed live routing never authorizes a retry or substitute model. A past failure with no recorded category remains unattributed; later diagnostics cannot establish its original cause.

An HTTP200 worker response does not establish a complete model stream. Owned Bun/SDK loopback fixtures cover Responses tool-use followed by terminal completion, and partial output without a terminal event. The latter must stop after one request, preserve unknown accounting and its isolated fixture marker, leave the approved file unchanged and withhold partial provider text. Only the pinned SDK's fixed missing-terminal/no-stop errors receive the finite `response_incomplete` label; unrelated or private errors remain unknown. These offline cases do not establish the cause of a past live failure or authorize another attempt.

## Artifact smoke

For the actual source ZIP: verify SHA256SUMS and safe paths, extract into a new folder, install production-only frozen dependencies with lifecycle scripts disabled, verify pinned versions and four-tool/`/jev-subagents` discovery, then run the existing `demo:job` in an isolated keyless environment. Expected demo receipts include3Bun workers,6loopback SDK calls, declared edit only, all children closed and no retained project lock.

A development node_modules tree or earlier ZIP cannot certify a different archive. A passing smoke is not real-provider quality, physical TUI interaction, arbitrary task correctness or human task acceptance. Actual observed release gates are recorded in the GitHub release notes.

## Native regression fixture preparation — v1.0.0

`check` now prepares the historical C1/Sol test children with the existing standalone Bun1.4.3 compiler before the normal native test run. This is test preparation, not a new production executor: ordinary `jev_*` workers and the source-only distribution remain source-based. No standalone executable, extra runtime or SDK upgrade is installed.

Generated `src/*worker.probe-*` files are ignored, same-checkout-only code artifacts and are never release ZIP inputs. The builder preserves original module/source identities and verifies Bun/SDK/undici pins, recorded build inputs and output hashes before code reuse; stale/missing/changed artifacts fail rather than falling back. Model profiles, permissions, leases and freshness results are never cached by this mechanism. The one-request fixture uses the fixed SDK's existing module map through Bun's native loader, while source/grant checks and all original scenario assertions remain active.

Native-owned protocol checks run before the full gate. They test SDK/config bindings, explicit SDK imports, inert dependency import and malformed/duplicate IPC for ESM and bytecode. Full CI must still finish every original scenario under four-file parallelism and its original outer deadlines. Successful synthetic tests do not authorize a live job.

## Historical regression data

All eleven historical native-failure scenarios remain under the unchanged30-second parent/15-second child limits. Fixed scenario/phase timings expose elapsed time and loopback/launch counters, not task source or provider output. Current fixtures additionally own25-second parent/10-second child work deadlines, reserving five seconds for the existing stop/drain/release sequence inside the unchanged framework limits. Their independent abort signal does not rely on the framework signal; late agent-directory reset also leaves a successor fixture's value intact. In one failed Linux run this stopped and settled at25.011seconds without a dangling-process kill or subsequent-parent cascade. Before these changes, a Linux PR run started its last scenario around29.8seconds and both framework signals stayed false after30seconds. Containment alone did not solve throughput. The native fixtures have separately passed all eleven scenarios and the three Sol native scenarios on Linux/macOS, including repeat and normal preparation-branch PR runs. The v1.0.0 release still requires exact final-commit public CI, native Windows and production-archive qualification, recorded in its release notes. Earlier/later successful gates do not erase the retained failed receipts or establish a universal performance guarantee. Investigate retained timings and fixture ownership without dropping scenarios, increasing deadlines, weakening cleanup or retrying paid work.

All source/test/script files are preserved from the reviewed development snapshot. The minimal `benchmarks/goal-c2` recorded metadata/hash-chain fixture and the two `docs/figures` diagrams are retained solely for unchanged regression coverage; they do not activate retired Goal, container, managed-context or SoL-Pi integration APIs. Other internal reports/screenshots and personal-path documentation are excluded. See [RELEASE-SOURCE.json](../RELEASE-SOURCE.json) and [third-party notices](../THIRD_PARTY_NOTICES.md).
