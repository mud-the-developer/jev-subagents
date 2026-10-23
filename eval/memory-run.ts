import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { memoryQualityCases, memoryQualityFixture, MEMORY_QUALITY_GATE, evaluateMemoryQuality, parseMemoryQualityReplay } from "./memory-quality.ts";

// Offline request generation/replay only; never read credentials or execute provider calls.
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--cases") {
    console.log(JSON.stringify({ syntheticOnly: true, gate: MEMORY_QUALITY_GATE, cases: memoryQualityCases }, null, 2)); return;
  }
  if (args.length === 2 && args[0] === "--request") {
    console.log(JSON.stringify(memoryQualityFixture(args[1]!).request)); return;
  }
  if (args.length !== 2 || args[0] !== "--replay") throw new Error();
  const file = await open(args[1]!, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > 65536) throw new Error();
    const buffer = Buffer.alloc(65537); let size = 0;
    while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > 65536) throw new Error(); text = buffer.subarray(0, size).toString("utf8");
  } finally { await file.close(); }
  const records = parseMemoryQualityReplay(text);
  console.log(JSON.stringify({ syntheticOnly: true, gate: MEMORY_QUALITY_GATE, development: evaluateMemoryQuality(records, "development"),
    heldout: evaluateMemoryQuality(records, "heldout"), qualification: evaluateMemoryQuality(records, "qualification"), confirmation: evaluateMemoryQuality(records, "confirmation") }, null, 2));
}
main().catch(() => { console.error("Offline memory-quality evaluation failed. Use --cases, --request <known-case-id>, or --replay <bounded-jsonl>. No provider calls were made."); process.exitCode = 1; });
