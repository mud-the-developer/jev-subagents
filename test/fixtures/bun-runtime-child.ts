import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const lifetime = setTimeout(() => process.exit(90), 20000);
let received = false;
process.once("disconnect", () => process.exit(1));
process.on("message", (value: unknown) => {
  if (value && typeof value === "object" && "type" in value && value.type === "cancel") {
    clearTimeout(lifetime); process.send!({ type: "cancelled" }, error => process.exit(error ? 91 : 0)); return;
  }
  if (received || !value || typeof value !== "object" || !("type" in value)) { process.exit(92); return; }
  received = true;
  if (value.type === "hold") {
    const child = spawn(process.execPath, [...process.execArgv, "--eval", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    child.unref(); process.send!({ type: "ready", pid: child.pid }); return;
  }
  if (value.type !== "echo" || !("text" in value) || typeof value.text !== "string") { process.exit(93); return; }
  clearTimeout(lifetime);
  process.send!({ type: "echo", text: value.text, bun: process.versions.bun, mainMatches: process.argv[1] === fileURLToPath(import.meta.url),
    poison: process.env.UNAPPROVED_BUN_ENV ?? null, ambientHook: process.env.BUN_OPTIONS ?? null, sdkImport: typeof getAgentDir === "function" }, error => process.exit(error ? 94 : 0));
});
