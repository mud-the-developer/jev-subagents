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

## Installed Pi1.3 UI surface — current main only

The updated opt-in probe is newer than the immutable RC1 ZIP. It requires an **existing Pi1.3.0 SDK directory** and the source checkout's frozen full dependencies; it does not install or adopt another host SDK:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json test/host-tui-surface.mjs "/absolute/path/to/existing-pi-1.3.0-package" "receipt.json"
```

This uses the installed host loader, native editor/renderer and a private test-only review bridge. Synthetic input checks complete literal source, untimed review waiting, positive submission, cancellation and edited-source denial; cards cover English three-level model/task lines at48/80/120columns. It also checks the separate standalone fixture, unchanged configuration and tool metadata limits. The receipt records the probe engine, host/worker SDK versions, zero network/worker calls and synthetic limitations. A positive synthetic review is never a live job grant or physical operator acceptance.

## Artifact smoke

For the actual source ZIP: verify SHA256SUMS and safe paths, extract into a new folder, install production-only frozen dependencies with lifecycle scripts disabled, verify pinned versions and four-tool/`/jev-subagents` discovery, then run the existing `demo:job` in an isolated keyless environment. Expected demo receipts include3Bun workers,6loopback SDK calls, declared edit only, all children closed and no retained project lock.

A development node_modules tree or earlier ZIP cannot certify a different archive. A passing smoke is not real-provider quality, physical TUI interaction, arbitrary task correctness or human task acceptance. Actual observed release gates are recorded in the GitHub release notes.

## Historical regression data

All eleven historical native-failure scenarios remain under the unchanged30-second parent/15-second child limits. Fixed scenario/phase timings expose elapsed time and loopback/launch counters, not task source or provider output. Current fixtures additionally own25-second parent/10-second child work deadlines, reserving five seconds for the existing stop/drain/release sequence inside the unchanged framework limits. Their independent abort signal does not rely on the framework signal; late agent-directory reset also leaves a successor fixture's value intact. In one failed Linux run this stopped and settled at25.011seconds without a dangling-process kill or subsequent-parent cascade. **Aggregate throughput remains a v1 qualification blocker:** before this containment change, a Linux PR run started its last scenario around29.8seconds and both framework signals stayed false after30seconds. Earlier signal checks alone did not contain that timeout, and containment does not prove that every scenario finishes within its work budget. Earlier/later successful gates do not erase that receipt. Investigate retained timings and fixture ownership without dropping scenarios, increasing deadlines, weakening cleanup or retrying paid work.

All source/test/script files are preserved from the reviewed development snapshot. The minimal `benchmarks/goal-c2` recorded metadata/hash-chain fixture and the two `docs/figures` diagrams are retained solely for unchanged regression coverage; they do not activate retired Goal, container, managed-context or SoL-Pi integration APIs. Other internal reports/screenshots and personal-path documentation are excluded. See [RELEASE-SOURCE.json](../RELEASE-SOURCE.json) and [third-party notices](../THIRD_PARTY_NOTICES.md).
