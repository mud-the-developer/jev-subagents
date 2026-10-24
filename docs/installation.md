# Installation and upgrades

Distribution is through [GitHub Releases](https://github.com/mud-the-developer/jev-subagents/releases), not npm. Prefer the exact versioned `jev-subagents-<version>-source.zip` asset and its `SHA256SUMS`. Keep the extracted folder: Pi loads local source from that path rather than copying it.

## Before installing

Use an existing Pi installation and standalone Bun1.4.3. Do not install or upgrade system runtimes implicitly. On Windows use a normal non-admin account, local fixed NTFS, no junction/reparse path and safe owner/DACL. A security refusal is not permission to elevate, repair ACLs, change global PATH or use another runtime.

Download from the official repository. Compare the archive SHA-256 with the exact filename in `SHA256SUMS` before extraction. Checksums detect changed bytes; their publisher identity still depends on obtaining them from the trusted release.

```powershell
Get-FileHash .\jev-subagents-1.0.0-source.zip -Algorithm SHA256
```

On Linux, `sha256sum --check SHA256SUMS` checks the published filename. Extract only after the match, into a new folder outside `node_modules`, and inspect its README/LICENSE. Never overwrite a running or locally edited installation.

## Prepare and register

Inside the extracted source root:

```text
bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json install --production --frozen-lockfile --ignore-scripts
pi install <absolute-extracted-folder>
```

Dependency installation can download pinned packages from the public npm registry. Lifecycle scripts are disabled. No Bun/Pi/model/driver installation or credential copying is performed. Production mode omits root TypeScript/ESLint development tools; source checks require a separate full frozen dependency install.

Use `pi list` to verify the exact registered path. Remove only the old JEV declaration if replacing an installation; preserve the old source folder, profiles, auth and unrelated settings. Do not leave two JEV copies registered. Finish active work before changing registration. Then `/reload` or restart Pi.

```text
/jev-subagents help
/jev-subagents runtime
/jev-subagents doctor
```

These commands do not prove real-provider execution. `/jev-subagents profiles` can prepare missing user profiles through its own exact-source review and preserves existing files. Review the configured provider/model/thinking/tools; examples and defaults do not guarantee account access. Use Pi's `/login` and `/model` separately. Never paste keys into chat or command arguments.

## First run

Read [usage](usage.md) and [security](security.md). Connection selection is not worker execution permission. Every new Reviewed job requires its genuine source approval; Full Access is an explicit session-only alternative with substantial cost/data risks. Reload never restores an old grant.

Retained locks or unknown accounting require human inspection, not forced cleanup, automatic reruns or permission restoration. Installation failure does not grant fallback to Node, another Bun version or a different model.
