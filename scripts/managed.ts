#!/usr/bin/env node
import { getAgentDir, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { CONTEXT_COMMAND_HELP, createManagedSession } from "../src/context-managed.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node /path/to/checkout/scripts/managed.ts --parent <fixed-user-profile>\nStarts a NEW single-extension pi session in the current directory. No inherited model or restored grants.\nNormal parent calls cost extra; context management is opt-in via /jev_compact <exact JSON>.\nUser settings are not changed. Unmanaged /compact, tree/fork/resume and automatic retry/compaction are disabled in this mode.\nParent profile tools plus this extension's tools are enabled; each retains its own approvals/budget.\nSee docs/context-management.md before use.");
  console.log("\n" + CONTEXT_COMMAND_HELP);
} else if (args.length !== 2 || args[0] !== "--parent" || !/^[a-z][a-z0-9_-]{0,63}$/.test(args[1]!) || !process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Managed mode requires a real TTY and --parent <explicit fixed user profile>. Use --help."); process.exitCode = 1;
} else {
  process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_DISABLE_ANALYTICS = "1"; process.env.PI_DISABLE_INSTALL_TELEMETRY = "1";
  try {
    const managed = await createManagedSession({ cwd: process.cwd(), agentDirectory: getAgentDir(), parent: args[1]! });
    try { await new InteractiveMode(managed.runtime).run(); } finally { await managed.dispose(); }
  } catch { console.error("Managed pi could not continue safely. No model fallback or automatic recovery. Inspect any retained ownership and journal before restarting."); process.exitCode = 1; }
}
