const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function planTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");

  const rows = [];
  const ids = new Set();
  for (const row of tasks) {
    if (row === null || typeof row !== "object" || Array.isArray(row) ||
        !Object.prototype.hasOwnProperty.call(row, "id") ||
        !Object.prototype.hasOwnProperty.call(row, "after")) {
      throw new TypeError("invalid task row");
    }
    const { id, after } = row;
    if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) {
      throw new TypeError("invalid or duplicate task id");
    }
    if (!Array.isArray(after)) throw new TypeError("invalid dependencies");
    const deps = [];
    const seen = new Set();
    for (const dep of after) {
      if (typeof dep !== "string" || !ID_RE.test(dep) || seen.has(dep) || dep === id) {
        throw new TypeError("invalid dependency");
      }
      seen.add(dep);
      deps.push(dep);
    }
    ids.add(id);
    rows.push({ id, deps });
  }

  const indegree = new Map();
  const dependents = new Map();
  for (const { id, deps } of rows) {
    indegree.set(id, deps.length);
    dependents.set(id, []);
  }
  for (const { id, deps } of rows) {
    for (const dep of deps) {
      if (!ids.has(dep)) throw new TypeError("unknown dependency");
      dependents.get(dep).push(id);
    }
  }

  let ready = rows.filter(({ id }) => indegree.get(id) === 0).map(({ id }) => id).sort();
  const layers = [];
  let processed = 0;
  while (ready.length) {
    const layer = ready.slice();
    layers.push(layer);
    processed += layer.length;
    const next = [];
    for (const id of layer) {
      for (const child of dependents.get(id)) {
        const count = indegree.get(child) - 1;
        indegree.set(child, count);
        if (count === 0) next.push(child);
      }
    }
    ready = next.sort();
  }
  if (processed !== rows.length) throw new RangeError("dependency cycle");
  return { order: layers.flat(), layers };
}
