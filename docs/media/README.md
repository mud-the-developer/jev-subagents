# UI previews and reproduction

These are **offline-rendered previews of the actual native UI components**, not screenshots of a user desktop, a screen recording, a live task, a benchmark or an approval receipt. The surrounding documentation frame is not part of the Pi terminal. Synthetic `demo/*` profile/model labels, counters and timing are illustrative and do not imply provider access or measured performance.

| File | Content |
| --- | --- |
| [workflow.gif](workflow.gif) |25native renderer frames: three dependency levels, inspection, exclusive file-ID edit, review and unverified ending; English model/task lines |
| [task-tree.png](task-tree.png) |Static view for readers who prefer no animation |
| [source-review.png](source-review.png) |The real native exact-source editor, scrolled to the top, never submitted; an ordinary-profile review separate from the tree example |
| [ended-unverified.png](ended-unverified.png) |The native plan's explicit unverified completion and human-review warning |
| [preview-report.json](preview-report.json) |Renderer source hashes, image hashes/sizes, synthetic/no-network/no-approval and owned-process cleanup observations |

The v1.0.0 previews include human-only task labels newer than RC1; the original RC1 ZIP and tag remain unchanged. Indented levels are dependencies among three declared tasks, not recursive agents or a larger worker budget. Labels are supplied separately from transcript-safe plan data and are not inferred from private task summaries.

The preview calls the existing `renderPlan` and `confirmNativeTaskReview`/native editor code with synthetic data, denies the review and never starts a model or task worker. The real pinned SDK dark theme is rasterized in a documentation window with system fonts; dim intensity/font rasterization can differ from a physical terminal. The full review packet remains scrollable in the actual UI; a still viewport is not evidence that its source was reviewed or approved.

## Recreate on Windows

Use an existing normal-user Windows environment, standalone **Bun1.4.3**, and the project's frozen full dependencies (SDK0.85.1). Windows PowerShell/System.Drawing and the installed Consolas/Segoe UI fonts are used. No Chrome, Python, ffmpeg, model/provider, package download or new project dependency is used by the capture helper.

From the source root:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json docs/media/capture-ui.mjs
```

The helper replaces only its own process environment with an isolated temporary HOME/configuration, forbids fetch, and supplies only fixed synthetic content. Existing owned Windows verification processes run the image renderer and decoder, and their Job cleanup must succeed. It never executes a shell shim, edits user profiles, reads credentials, grants approval or invokes a model. Outputs replace these generated preview files; failed intermediate work is retained locally rather than silently retried.

Assertions check native column bounds, allowed synthetic content, image dimensions, palette/GIF structure and size, and decode all25GIF frames with the system image decoder. Assets are copied into this directory only after those checks pass. The GIF has a final-state pause and is under1MiB; the linked still image provides a reduced-motion alternative.

These documentation-only additions do not modify the published `v1.0.0-rc.1` tag, ZIP or checksum. Regenerate previews if the native renderer changes rather than presenting a manually redrawn UI as an actual execution.
