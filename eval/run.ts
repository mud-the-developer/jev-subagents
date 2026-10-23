import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { cases, evaluate, parseReplay, profiles, ruleBaseline } from "./evaluate.ts";

// Offline adapter only: no credentials, SDK, network, or agent execution.
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--cases") {
    console.log(JSON.stringify({ profiles, cases }, null, 2));
    return;
  }
  let predictions: unknown;
  let mode: string;
  if (args.length === 0) {
    mode = "rules";
    predictions = cases.map(({ id, task }) => ({ id, agent: ruleBaseline(task) }));
  } else if (args.length === 2 && args[0] === "--fixed" && profiles.some((profile) => profile === args[1])) {
    mode = `fixed:${args[1]}`;
    predictions = cases.map(({ id }) => ({ id, agent: args[1] }));
  } else if (args.length === 2 && args[0] === "--replay") {
    mode = "replay";
    const file = await open(args[1]!, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Not a regular file.");
      const buffer = Buffer.alloc(65_537);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 65_536) throw new Error("Replay file too large.");
      predictions = parseReplay(buffer.subarray(0, size).toString("utf8"));
    } finally { await file.close(); }
  } else throw new Error("Unsupported arguments.");
  console.log(JSON.stringify({ mode, ...evaluate(predictions) }, null, 2));
}

main().catch(() => {
  console.error("Offline evaluation failed. Use: npm run eval -- [--cases | --fixed scout|worker|worker_strong | --replay results.jsonl]. Replay must contain at most 20 unique {id, agent} records in 64 KiB; agent may be null for failure. No network requests were made.");
  process.exitCode = 1;
});
