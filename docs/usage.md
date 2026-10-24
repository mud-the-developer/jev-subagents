# Usage

The native command is `/jev-subagents`; `/jev` is not an alias. Ask the parent naturally for a bounded task, or use an explicit direct command. Keep model-facing task prose in English; preserve source, paths and literal Unicode unchanged.

## Configuration and diagnostics

```text
/jev-subagents
/jev-subagents help
/jev-subagents status
/jev-subagents profiles
/jev-subagents runtime
/jev-subagents doctor
/jev-subagents doctor last
```

The session picker chooses a JEV decision-backend preference, not a worker model or execution grant. Initial interactive discovery is limited to known/explicit literal-loopback metadata endpoints; remote inference and local-model installation are not implied. `profiles` separately reviews creation of missing fixed-profile files. Existing files are not overwritten.

`runtime` inspects the active tool catalog. `doctor` performs bounded environment/SDK checks without a model call; `doctor last` shows recorded failure metadata in the same session, not a fresh check. Independent directory targets have separate owned readers, and an absent environment report does not imply a failed SDK import. Reviewed managed Node/Bun Pi launchers are recognized without running shell shims. These observations do not certify physical display, account access or task correctness.

## Direct read-only example

Prepare a non-sensitive existing `sample.txt` in the current workspace and an existing supported `scout` profile. This example is not execution approval:

```text
/jev-subagents run {"agent":"scout","task":"Read sample.txt and report its content.","files":[{"path":"sample.txt","access":"read"}],"seconds":120,"maxModelCalls":2}
/jev-subagents result
/jev-subagents cancel
```

Review the exact model, thinking, effective tools, workspace, file IDs, source and limits before accepting. Model calls can incur charges. The fixed user profile is not inherited from the parent. Scope tools expose only approved existing file IDs; no discovery, shell, new file or implicit verifier is added to this direct path.

`result` explicitly opens the last unverified worker text for that session. `cancel` requests stop and waits for owned cleanup; it does not roll back edits. Source changes, lifecycle navigation, invalid replies and unknown ownership stop admission, not trigger a fallback.

## Model-facing APIs

- `jev_route`: candidate recommendation only.
- `jev_decide`: ordinary choice/legacy manual budget advice. Mandatory human approvals are not decided by a model.
- `jev_delegate`: ordinary single task, sequential `scope`/`graph`, independent `parallelRead`, or parent-authored `tree` with explicit dependencies/references. Use the registered schema and fixed profiles; do not manufacture grants or authority from a memory record.
- `jev_memory`: parent-only explicit SQLite administration. Combined-job memory sharing has its own declared scope; no automatic collection or child database access.

One permitted plan skips JEV selection, not authorization. Multiple candidates are selected only within the approved packet. No duplicate routing, paid width planner, automatic retry/escalation or arbitrary model changes. Generated downstream references need their existing disclosure authority and remain untrusted reference data.

## English task labels and visible depth — v1.0.0

This UI is included in v1.0.0 and is newer than the immutable RC1 ZIP. For a declared tree, optional reviewed labels are keyed by its existing task IDs:

```json
{
  "display": {
    "maxDepth": 3,
    "animations": true,
    "labels": {
      "inspect": "Inspect the approved module",
      "edit": "Apply the declared file-ID edit",
      "review": "Review the declared changes"
    }
  }
}
```

Use short English, non-sensitive descriptions: at most3labels/120characters each, declared task IDs only. Labels bind to the source approval but appear only through the human widget channel after authorization; worker inputs, JEV routing and transcript-safe receipts do not receive them. Missing labels use fixed English read/mutation text, never raw task summaries. The model and task description share one compact line, with thinking/observed SDK metadata retained below. Long lines show their head plus an omission marker; control/address text cannot forge terminal rows.

A three-level chain still executes at most3workers total. Display depth does not create new tasks, recursive agents, wider concurrency, model requests or restored approval. Narrow/collapsed views retain hidden-state counts and exact source review stays authoritative.

## Permission modes

```text
/jev-subagents access
/jev-subagents access full
/jev-subagents access reviewed
```

Reviewed is the default. Full Access requires the actual native risk acknowledgement and temporarily covers routine declared delegation/sharing/verification/evidence operations for the live session. It is not a blanket installation, profile-creation, other-extension or standalone memory-administration grant. It is revoked on explicit Reviewed and the documented session/navigation/setup/reload boundaries; it is never persisted or restored.

Jobs default to SDK natural completion with no model-round cap unless an explicit finite cap was approved, and up to24hours unless narrowed. Old approvals are not extended. Neither seconds nor SDK rounds are token/dollar quotas; Full Access has no cumulative session spending cap. Task trees execute at most3workers total, with overlapping read lanes and exclusive mutations. See [security and limits](security.md).

All worker outputs are unverified data. A successful process or fixture is not general task acceptance, model-quality evidence or permission for another job.
