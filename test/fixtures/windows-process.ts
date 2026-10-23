import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownWindowsProcess } from "../../src/windows-job.ts";

const filename = fileURLToPath(import.meta.url);
if (process.argv[2] === "coordinator") {
  const earliest = Date.now();
  const child = childProcess.fork(filename, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const job = await ownWindowsProcess(child, earliest);
  child.on("message", (message) => process.send?.(message));
  child.send({ filename: process.argv[3] });
  process.on("message", async () => { await job.close(); process.exit(0); });
} else {
  process.once("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("filename" in message) || typeof message.filename !== "string") process.exit(1);
    const code = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(message.filename)},String(process.pid));setInterval(()=>{},1000)`;
    const child = childProcess.spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
    process.send?.({ pid: child.pid }, () => process.exit(0));
  });
}
