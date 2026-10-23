# jev-subagents

JEV-assisted subagents for [Pi](https://pi.dev): explicit worker selection, reviewed task execution, bounded parent/child reference sharing and owned process cleanup.

**Public distribution is being prepared. No installable release asset has been published yet.** This repository hosts distribution information and future GitHub Releases; it is not a checkout of the extension runtime or its private development history.

## Distribution

- Official channel: [GitHub Releases](https://github.com/mud-the-developer/jev-subagents/releases).
- Planned assets: a versioned `jev-subagents-<version>-source.zip` and `SHA256SUMS`.
- No npm publication of `jev-subagents`. Its package manifest remains `private: true` to prevent accidental npm publishing.
- Source archives do not bundle Bun, Pi, credentials, user profiles or `node_modules`.
- Do **not** run `pi install` against this distribution repository. Install the verified extracted release folder only after an actual release asset is available.

## Requirements

An existing Pi installation and standalone **Bun 1.4.3** are required. Workers retain the pinned **Pi SDK 0.85.1 / TypeBox 1.3.7**. A Node-hosted Pi can have separate host requirements; the extension does not install or upgrade system runtimes.

Downloading a source ZIP does not grant model execution authority. Preparing frozen dependencies can download packages from the public npm registry even though this project itself is distributed only through GitHub Releases.

## User interface

The extension command is **`/jev-subagents`**, not `/jev`. Model-facing tool APIs are:

| Tool | Purpose |
| --- | --- |
| `jev_route` | Recommend among explicit candidates; no execution authority |
| `jev_decide` | Bounded option advice; mandatory human approvals stay human |
| `jev_delegate` | Run explicit fixed-profile workers under the approved scope and limits |
| `jev_memory` | Explicit parent-only memory administration |

Worker completion is not task acceptance. JEV recommendations are advice, not permission or proof. Ordinary workers can access files and shell capabilities permitted to the OS user when their profile allows them; this is **not an OS sandbox or rollback**. Model calls can incur charges. Approval, cancellation, freshness, ownership and unknown-cleanup checks remain binding; failures do not grant an automatic retry or fallback.

## Release readiness

Final public content review, artifact extraction/production-install smoke, version selection and release publication are still pending. Development checks do not certify an unpublished archive, physical TUI behavior, real-provider quality/billing or arbitrary task correctness. No stable v1 release is claimed here.

## License

Original project work is licensed under [MIT](LICENSE). Source assets must retain applicable third-party notices; included third-party code keeps its own copyright and license.
