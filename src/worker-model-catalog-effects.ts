import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface WorkerModelCatalog {
  readonly sdkVersion: "0.85.1";
  getAvailableSnapshot(): readonly Model<Api>[];
  getModel(provider: string, id: string): Model<Api> | undefined;
  thinkingLevels(model: Model<Api>): ModelThinkingLevel[];
}

/** Resolve the installed worker SDK directly: Pi may map bare SDK imports to a different host version. */
export async function readWorkerModelCatalog(agentDirectory: string, signal: AbortSignal): Promise<WorkerModelCatalog> {
  const sdk = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href);
  if (sdk.VERSION !== "0.85.1" || typeof sdk.ModelRuntime?.create !== "function") throw new Error("Pinned worker model catalog unavailable; no host-model substitution.");
  const entry = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url));
  const peer = await import(import.meta.resolve("@earendil-works/pi-ai", pathToFileURL(entry).href));
  if (typeof peer.getSupportedThinkingLevels !== "function") throw new Error("Pinned worker thinking metadata unavailable.");
  signal.throwIfAborted();
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath: path.join(agentDirectory, "models.json"), allowModelNetwork: false, signal });
  return { sdkVersion: "0.85.1", getAvailableSnapshot: () => runtime.getAvailableSnapshot(), getModel: (provider, id) => runtime.getModel(provider, id),
    thinkingLevels: model => (peer.getSupportedThinkingLevels(model) as ModelThinkingLevel[]).filter(level => {
      const mapped = model.thinkingLevelMap?.[level]; return mapped === undefined || mapped === level;
    }) };

}
