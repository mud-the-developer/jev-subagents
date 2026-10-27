# Security and limits

## Dependency security status

v1.0.0 changes only the existing SDK-scoped `undici` override from8.10.2 to8.12.2. Bun1.4.3, SDK0.85.1, TypeBox1.3.7 and the adjacent brace-expansion override remain fixed. New registry advisories affect the previous8.x version: [EventSource memory DoS](https://github.com/advisories/GHSA-4qv8-2p9j-2685), [SRI token bypass](https://github.com/advisories/GHSA-f72v-6w45-q472), and [content-encoding error DoS](https://github.com/advisories/GHSA-xjj6-f33q-929c). All list8.12.2 as the patched8.x version.

The original RC1 tag/ZIP are immutable and retain8.10.2; earlier successful audits describe the advisory database at that time, not current security acceptance. Use the separately versioned v1.0.0 assets for the patched source; RC1 assets are not replaced. Source audit and regression checks must pass without lowering thresholds; a clean audit is not proof that unknown vulnerabilities do not exist.

## Trust and execution

Pi extensions run with the host user's permissions. Ordinary fixed profiles can access other user-readable files and run shell commands when their tools allow it. This is not an OS sandbox or a rollback system. Use only trusted source and reviewed non-sensitive inputs. Authentication is supplied by the existing Pi runtime, not by placing keys into tasks, profiles, commands or release files.

Reviewed execution needs the exact genuine native review. Advice, displayed JSON, a source-only acknowledgement, a saved setting, a memory record or a rendered dialog is not execution authority. TUI approval requires unchanged submission and the actual SDK receipt; supported GUI/RPC paths require the readonly literal-positive reply. Missing/edited/stale/nonliteral/error replies stop without an alternate route.

Explicit Full Access is live session delegation authority only. It does not authorize runtime installation, profile creation, administrator elevation, deliberate secret forwarding, other extensions or standalone memory administration. Revocation drains work; session/fork/tree/compact/shutdown/reload and connection/profile changes do not restore it.

## Files, freshness and ownership

Restricted scope workers expose declared existing UTF-8 file IDs only: at most16files,32KiB each/128KiB total,64file operations per worker. Project instructions, extension runtime, auth/config and owned storage remain protected. Read-only ordinary profiles are limited tool sets, not file-ID isolation. Tree mutation lanes are exclusive; independent reads can overlap.

Native Windows requires a non-admin actor, local fixed NTFS, trusted SID/DACL and canonical bound file identities. Job ownership is established before payload admission. Fresh reads reopen native scopes and recheck permissions, identities and contents. Invocation-local native code/process reuse is not a cache of permission or freshness results; checked handle closure and final Job cleanup precede owner release.

Cancellation and failures drain owned operations. Unknown cleanup, storage application or accounting remains unknown and can retain locks. Do not delete markers, steal ownership, repair permissions, increase deadlines or silently retry to manufacture success. File changes may remain after a cancelled/failed run.

## Routing, sharing and cost

Ordinary fixed-profile advice sends explicit reviewed task/option/candidate metadata. Automatic available-model/thinking selection separately prepares current approved-file source plus parent-supplied constraints/relevant observations, and sends it only after its genuine exact-source disclosure review to the displayed backend. This new disclosure review is not skipped in Full Access. It does not collect ambient transcripts, unrelated files, credentials or raw provider errors. Availability/capability metadata is not quota, correctness or inference proof; aliases, unavailable targets, catalog overflow and invalid selection stop without a fallback. A valid weak recommendation is preserved unchanged and requires explicit human selected-worker approval even in Full Access. Optional completion assessment uses only its authorized bounded evidence after passed declared verification. Reference bodies are untrusted data and are disclosed only to selected approved recipients; no ambient sibling/history sharing or child database tool is added.

Advice is not proof or permission. Default ordinary runs may use SDK natural completion and up to24hours unless explicitly narrowed. Finite approved caps remain exact and cannot be extended; old grants are not revived. SDK/time boundaries are not token, money or provider-request quotas. Full Access has no cumulative session spending cap. Unknown total cost is not zero.

No automatic model/provider fallback, retries, task acceptance, recursive delegation or runtime upgrades are implied. Completion remains unverified until the actual declared checks and human review support it.

## Report a problem

Do not post keys, raw user prompts, private code, session/auth files or complete local logs in public issues. Share only a redacted minimal reproduction and fixed diagnostic categories/counts. If ownership is unknown, preserve local evidence and stop new execution rather than forcing recovery. Public source fixtures are regression data, not saved execution permission.
