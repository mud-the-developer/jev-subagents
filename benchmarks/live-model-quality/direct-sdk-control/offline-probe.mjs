// Real owned-child/file-guard probe. Never creates a ModelRuntime or SDK prompt.
import { createControlTools } from "./scope-tools.mjs";
let received = false;
const controller = new AbortController();
process.once("disconnect", () => controller.abort());
process.on("message", async input => {
  if (input?.type === "direct_control_cancel") { controller.abort(); return; }
  if (received) { controller.abort(); return; } received = true;
  try {
    if (input.probeMode === "wait") {
      await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }));
      process.send({ type: "direct_sdk_result", id: input.id, status: "cancelled", sdkCalls: 0, sdkCallCap: null,
        disposed: true, files: { ioFinished: false }, accounting: { status: "not_started", complete: false, observedUsdEstimate: null } }, () => process.exit(0));
      return;
    }
    const tools = await createControlTools({ ...input, signal: controller.signal });
    const checks = [];
    await tools.withinBatch(async () => {
      const read = tools.tools.find(tool => tool.name === "scope_read"), write = tools.tools.find(tool => tool.name === "scope_write"), edit = tools.tools.find(tool => tool.name === "scope_edit");
      const first = await read.execute("probe-read", { fileId: "file-1" }, controller.signal);
      if (first.content[0].text !== "before") throw new Error("Probe mismatch"); checks.push("read");
      await write.execute("probe-write", { fileId: "file-1", text: "middle" }, controller.signal); checks.push("write");
      await edit.execute("probe-edit", { fileId: "file-1", oldText: "middle", newText: "after" }, controller.signal); checks.push("edit");
      const last = await read.execute("probe-reread", { fileId: "file-1" }, controller.signal);
      if (last.content[0].text !== "after") throw new Error("Probe mismatch"); checks.push("version_updated");
    });
    const files = await tools.close();
    process.send({ type: "direct_sdk_result", id: input.id, status: "offline_probe", sdkCalls: 0, sdkCallCap: null, checks,
      disposed: true, files, accounting: { status: "not_started", complete: false, observedUsdEstimate: null } }, () => process.exit(0));
  } catch {
    process.send({ type: "direct_sdk_result", id: input.id, status: "failed", failureStage: "offline_guard_probe", sdkCalls: 0, sdkCallCap: null,
      disposed: true, files: { ioFinished: false }, accounting: { status: "not_started", complete: false, observedUsdEstimate: null } }, () => process.exit(1));
  }
});
