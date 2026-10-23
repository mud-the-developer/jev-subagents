import childProcess, { type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { VerificationCommandSchema } from "./delegate-machine.ts";

// The parent enrolls this idle wrapper in a Job Object before sending the command.
// Descendants inherit the job; the guardian confirms cleanup after this wrapper exits.
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  let child: ChildProcess | undefined;
  let started = false, finished = false;
  const finish = (exitCode: number | null) => {
    if (finished) return;
    finished = true;
    if (process.connected) process.send!({ exitCode }, () => process.exit(0));
    else process.exit(1);
  };
  const stop = () => { child?.kill("SIGKILL"); finish(null); };
  process.once("disconnect", stop);
  process.once("SIGTERM", stop);
  process.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && Object.keys(message).length === 1 &&
      "type" in message && message.type === "jev_worker_cancel") { stop(); return; }
    if (started || !Value.Check(VerificationCommandSchema, message)) { stop(); return; }
    started = true;
    try {
      child = childProcess.spawn(message.command, message.args, { shell: false, detached: false, stdio: "ignore" });
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
    } catch { finish(null); }
  });
}
