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

`runtime` inspects the active tool catalog and shows the package path/version metadata used by this diagnostic. The path identifies the command handler's package, not proof of the active tool owner or loaded code bytes; changing the terminal's working directory does not change Pi's registered package. Check `pi list` before changing registration and reload only after finishing active work. Permission mode is not inferred or restored by metadata: use `/jev-subagents access` to inspect it. `doctor` includes the same code identity and performs bounded environment/SDK checks without a model call; `doctor last` shows recorded failure metadata in the same session plus the current diagnostic package identity, not a fresh check or proof that the current code produced that historical failure. Native execution, scoped tool results and cached failure summaries share fixed worker-cause/stage labels and a reported HTTP status when present. For example, authentication/401 is shown without the provider's raw error body; it is not inferred from generic failures or treated as proof of cleanup. Follow the displayed read-only checks and preserve retained files/locks; never force cleanup or automatically rerun a stopped job. Independent directory targets have separate owned readers, and an absent environment report does not imply a failed SDK import. Reviewed managed Node/Bun Pi launchers are recognized without running shell shims. These observations do not certify physical display, account access or task correctness.

## Context-aware automatic execution

`/jev-subagents run` defaults to an available-model/thinking choice when the current execution owner supports automatic selection. `agent` or `role` names a permission/prompt template only; its fixed model/thinking headers are ignored in automatic mode. The template body and effective tools still receive exact review. Model options come from the worker runtime's configured offline availability snapshot, not a guessed model name or a real-provider probe. Canonical SDK thinking levels include `off` and `minimal` only when actually supported without aliasing. The selected model, API/endpoint and effort are rechecked before SDK execution; unsupported effort is never silently clamped.

The parent supplies `auto:{task,files,constraints?,observations?,role?,seconds?,maxModelCalls?}` to `jev_delegate`; it does not ask users to write a candidate catalog. Approved file content supplies actual current code context. Only goal, constraints, file source data and relevant observations enter the routing packet. Whole conversation, unrelated files, auth and provider error bodies are not gathered. Context is bounded to128KiB; the automatic catalog permits128models with up to7canonical levels each (maximum896eligible model/thinking pairs). TypeSafe permits255criteria per choice question. The reviewed conditional plan therefore makes at most2dependent requests: choose from at most128models, then choose from only the selected model's at most7canonical levels. Singleton stages bypass JEV, not approval. These are not independent model/effort guesses; the reducer rejects another model's levels and never re-selects after failure. The same approved current-task context may be transmitted twice. An eligible recommendation below0.5support is preserved unchanged as advice, not an execution grant. Every weak model/thinking stage is displayed in the actual selected-worker review, which requires an explicit human reply even in Full Access. Declining or cancelling that review starts no worker; no alternative model is selected. Oversized/ambiguous catalogs fail instead of dropping candidates. The explicit fixed-profile pool's128-plan bound is unchanged. Source disclosure is a separate genuine native review even in Full Access, followed by the ordinary selected-worker review. One eligible combination makes no routing request. Neither review is saved or restored as a grant.

For an explicitly fixed native run add `modelSelection:"fixed"` with the existing `agent`. Existing explicit fixed-profile, `scope`, `graph`, `tree` and read-only batch APIs preserve their fixed-model contracts. Automatic selection currently dispatches one scoped worker; it does not turn an already approved multi-stage job into per-turn model switching. No model-quality or latency gain is claimed before a separately approved matched evaluation.

## Direct read-only example

Prepare a non-sensitive existing `sample.txt` in the current workspace and an existing supported `scout` profile. This example is not execution approval:

```text
/jev-subagents run {"agent":"scout","task":"Read sample.txt and report its content.","files":[{"path":"sample.txt","access":"read"}],"seconds":120,"maxModelCalls":2}
/jev-subagents result
/jev-subagents cancel
```

Review the exact routing context/catalog first, then the actual selected model, thinking, effective tools, workspace, file IDs, source and limits before accepting. Model calls can incur charges. The permission template and selected worker are not inherited from the parent model. Scope tools expose only approved existing file IDs; no discovery, shell, new file or implicit verifier is added to this direct path.

`result` explicitly opens the last unverified worker text for that session. `cancel` requests stop and waits for owned cleanup; it does not roll back edits. Source changes, lifecycle navigation, invalid replies and unknown ownership stop admission, not trigger a fallback.

## Model-facing APIs

- `jev_route`: candidate recommendation only.
- `jev_decide`: ordinary choice/legacy manual budget advice. Mandatory human approvals are not decided by a model.
- `jev_delegate`: prefer the `auto` branch for a current-task-context-driven available model/thinking choice and one scoped worker. Explicit legacy fixed-profile single tasks, sequential `scope`/`graph`, independent `parallelRead`, and parent-authored `tree` remain supported. Use the registered schema; never manufacture grants or authority from a memory record.
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
