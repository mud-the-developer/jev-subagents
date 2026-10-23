import path from "node:path";
import { canonicalDirectory } from "./goal-run-effects.ts";
import { memoryDigest, memoryProjectKey, memorySnapshot, type MemoryFact, type MemorySnapshot } from "./project-memory.ts";
import { readProjectMemory, probeMemoryCreation, mutateProjectMemory, ProjectMemoryError, type MemoryRead } from "./project-memory-store.ts";
import { validDelegationMemoryInput, validDelegationMemorySource, validDelegationMemorySelection,
  type DelegationMemoryInput, type DelegationMemorySource } from "./delegation-memory.ts";

export type PreparedDelegationMemory = { readonly directory: string; readonly token: string; readonly input: DelegationMemoryInput; readonly data: DelegationMemorySource };
export const delegationMemoryIO = { canonical: canonicalDirectory, read: readProjectMemory, probe: probeMemoryCreation, mutate: mutateProjectMemory };
const refused = (): never => { throw new ProjectMemoryError("changed"); };
const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** Preparation only reads. All creation and declared appends wait for the job's actual native approval. */
export async function prepareDelegationMemory(input: DelegationMemoryInput, project: string, signal: AbortSignal): Promise<PreparedDelegationMemory> {
  if (!validDelegationMemoryInput(input)) return refused();
  const owned = structuredClone(input), projectKey = memoryProjectKey(project);
  const directory = await delegationMemoryIO.canonical(owned.directory, true, signal);
  if (inside(project, directory) || inside(directory, project)) return refused();
  let token: string, revision = 0, records: MemoryFact[] = [];
  if (owned.create) token = (await delegationMemoryIO.probe(directory, signal)).token;
  else {
    const current = await delegationMemoryIO.read(directory, projectKey, signal); token = current.token; revision = current.state.revision;
    const ids = owned.ids ?? current.state.facts.map(record => record.id);
    records = ids.map(id => current.state.facts.find(record => record.id === id) ?? refused());
  }
  const data: DelegationMemorySource = { version: 1, projectKey, directoryRef: memoryDigest(directory), revision,
    query: owned.query, records: structuredClone(records), additions: structuredClone(owned.remember ?? []) };
  if (!validDelegationMemorySource(data, projectKey)) return refused();
  return { directory, token, input: owned, data };
}
/** The caller must own the exact approved job. No popup, ambient allowance or reusable grant is created here. */
export async function applyDelegationMemory(prepared: PreparedDelegationMemory, signal: AbortSignal): Promise<MemorySnapshot | undefined> {
  const { directory, data, input, token } = prepared;
  if (!validDelegationMemoryInput(input) || !validDelegationMemorySource(data) || data.directoryRef !== memoryDigest(directory)) return refused();
  signal.throwIfAborted();
  let current: MemoryRead;
  if (input.create) {
    if ((await delegationMemoryIO.probe(directory, signal)).token !== token) return refused();
    current = await delegationMemoryIO.mutate({ operation: "create", directory }, data.projectKey, token, signal);
  } else {
    current = await delegationMemoryIO.read(directory, data.projectKey, signal);
    if (current.token !== token || current.state.revision !== data.revision) return refused();
  }
  const records = structuredClone(data.records);
  for (const record of data.additions) {
    signal.throwIfAborted();
    const saved = await delegationMemoryIO.mutate({ operation: "remember", directory, expectedRevision: current.state.revision, record }, data.projectKey, current.token, signal);
    const addition = saved.state.facts.find(row => row.id === saved.id); if (!addition) return refused();
    records.push(addition); current = saved;
  }
  signal.throwIfAborted();
  if (!records.length) return undefined;
  const catalog = memorySnapshot({ version: 1, projectKey: data.projectKey, revision: current.state.revision, facts: records, edges: [] }, records.map(record => record.id));
  if (!validDelegationMemorySelection(data, catalog)) return refused();
  return catalog;
}
