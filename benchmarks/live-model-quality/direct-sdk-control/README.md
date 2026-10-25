# Direct SDK control — shared safety, no JEV execution layer

This follow-up was requested after the registered [JEV-on12-trial study](../suite-v2/RESULTS.md). It is a **direct pinned-SDK execution-layer ablation**, not a claim that all JEV-derived source code or safety utilities have vanished.

## Treatment difference

The child creates `createAgentSession` directly from the existing Bun1.4.3/worker SDK0.85.1. No JEV extension factory, public tool, `jev_delegate`, routing/selection/judge, approval packet, execution lease, worker/run reducer or production execution function is invoked. Existing worker/worker_strong profiles, model/thinking, initial task bytes, task summary, instruction-source selection recipe, file-ID schemas and test cases are matched as far as captured evidence permits.

To avoid silently weakening security merely to manufacture a baseline, **both arms retain the same low-level file-state/native file-I/O/instruction-version/Windows Job/sealed Bun utilities**. Those shared code dependencies are explicit in `scope-tools.mjs` and `owned-run.mjs`. The operator's new closed direct-control request authorizes these fresh synthetic file scopes; their private file-machine transition is not a fabricated JEV grant/approval receipt/lease or restored Full Access. Stored JSON cannot authorize execution.

There is no ordinary unrestricted shell/path tool. Only scope_read/edit/write expose the exact existing file IDs; SPEC is read-only. File identity, DACL/SID, stale instructions, cancellation, operation/byte limits and Job descendant cleanup remain fail-closed. Credential values stay in SDK ModelRuntime memory using the existing explicit auth/model stores; no auth file is copied, logged, prompted or published. Child credential environment variables and ambient runtime hooks are not inherited. This is not an OS sandbox.

## Closed operator-authorized follow-up

-12fresh trials: same three tasks ×same two existing low/max profiles ×two repeats and exact v2catalog order. Uncapped SDK rounds/natural completion, one child,300seconds pertrial. No automatic retry/model/cwd/profile fallback, new profile creation, extra judge or deadline extension.
- Native/SDK/provider failure, incomplete accounting or unknown child/Job/file-I/O cleanup stops subsequent scheduling. A completed candidate failing independent checks remains a task failure, not parent-repaired or silently rerun. No best-of selection.
- New private directories are protected at creation under the same original workspace; old fixtures/configs/profiles/ACLs remain unchanged. Workers get only the two mutable modules and SPEC, never checks, references, earlier outputs or test feedback. Parent reviews code before executing held-out checks.
- Source/spec/checks and profile-body hashes must match the JEV-on records. The exact model/active tools/thinking/system SDK suffix are asserted before requests. Profile/config/instruction versions are freshly checked before every request/file operation.

## Important matching limits

The JEV-on study did not retain full historical assembled system-prompt hashes or individual internal SDK-phase timings. Fresh fixture/manifest paths and instruction-source paths differ. The direct recipe reproduces the known framing but cannot prove byte-identical historical prompts. This follow-up runs **after** JEV-on rather than interleaving the two arms, so provider/machine-load/time drift is not controlled. Thinking remains low/max across the profiles, not equalized for model-only ranking.

JEV-on reported native-job elapsed time; direct control reports both child SDK-worker and parent-owned end-to-end elapsed. Their boundary equivalence is not established. Do not label the difference pure JEV overhead. Cost fields are model-metadata estimates, not invoices/upstream identity audits. No general quality, security/cleanup superiority or JEV routing benefit can be inferred from this scoped maintenance study alone; JEV-on routing requests were already0.

## Offline preflight before any provider request

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json benchmarks/live-model-quality/direct-sdk-control/offline-tests.mjs <existing-runtime-source-root>
```

Tests use newly protected owned fixtures, real Windows Job/file guards, and an explicitly fake SDK only for session-wiring/accounting-unit tests. They verify read/write/edit/version updates, read-only/unknown-ID/closed-schema/stale-file/stale-instruction/cancel refusal, deadline Job closure, missing-usage/count rejection and disposal. They make0real provider calls and read no existing credentials. Failed offline evidence is retained. Mock accounting is never live benchmark evidence.

A separate explicit `preflight` creates an **actual** pinned SDK session with the existing configured model/thinking/file tools and immediately aborts/disposes without `prompt()`. It may load existing credentials effect-locally but starts0model requests. This catches SDK/import/model/tool setup errors before billing. Missing usage or a missing child receipt remains unknown, never fabricated zero-cost success.

The SDK package exposes an ESM-only root entry; the harness uses its verified pinned `dist/index.js`, not a CommonJS-resolution fallback or another SDK version. Preparation caught and fixed that import mismatch before any live request.

`runner.mjs <existing-runtime-source-root> <new-private-relative-root> <index> preflight|live` is an explicit benchmark CLI, not an automatically authorized product command. A caller must supply current authority for the closed study, trusted runtime source, protected fresh fixtures and valid protocol hashes. It never dispatches GitHub Actions, installs a runtime/dependency or modifies the product. `[skip ci]` evidence-only commits do not waive product release gates. Immutable v1.0.0 assets/main are unchanged.
