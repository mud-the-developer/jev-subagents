// Trusted container PID 1. No pi runtime, credentials, discovery, shell interpolation, or captured command output.
import cp from "node:child_process";
import fs from "node:fs";

const invalid = () => process.exit(125);
if (process.platform !== "linux" || process.pid !== 1 || !process.getuid || process.getuid() === 0 || Number(process.versions.node.split(".")[0]) < 22) invalid();
let input;
try {
  // A same-UID test must not debug/patch PID 1 to remove its independent deadline.
  if (process.execArgv.length !== 1 || process.execArgv[0] !== "--disable-sigusr1" ||
      !["1", "2", "3"].includes(fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim())) invalid();
  if (!process.argv[2] || Buffer.byteLength(process.argv[2]) > 49152) invalid();
  input = JSON.parse(process.argv[2]);
  if (!input || Object.keys(input).sort().join(",") !== "args,command,deadline" ||
      typeof input.command !== "string" || !input.command.startsWith("/") || input.command.includes("\0") ||
      !Array.isArray(input.args) || input.args.length > 32 || input.args.some(arg => typeof arg !== "string" || arg.length > 1024 || arg.includes("\0")) ||
      !Number.isSafeInteger(input.deadline)) invalid();
} catch { invalid(); }
// Host verifies the daemon clock within 1s. Keep that margin and an independent 30s ceiling if the host dies.
const remaining = Math.min(30000, input.deadline - Date.now() - 1000);
if (remaining <= 0) process.exit(124);
setTimeout(() => process.exit(124), remaining);
process.on("SIGTERM", () => process.exit(125));
process.on("SIGINT", () => process.exit(125));
try {
  const child = cp.spawn(input.command, input.args, { cwd: "/workspace", env: process.env, shell: false, stdio: "ignore" });
  child.once("error", invalid);
  child.once("close", (code, signal) => {
    // Leaving PID 1 terminates the entire PID namespace, including detached/reparented descendants.
    process.exit(signal === null && Number.isInteger(code) && code >= 0 && code < 124 ? code : 125);
  });
} catch { invalid(); }
