export function planTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");
  const idPattern = /^[a-z][a-z0-9_-]{0,31}$/;
  const ids = new Set();
  const rows = [];
  for (const row of tasks) {
    if (row === null || typeof row !== "object" || Array.isArray(row) ||
        !Object.prototype.hasOwnProperty.call(row, "id") ||
        !Object.prototype.hasOwnProperty.call(row, "after") ||
        typeof row.id !== "string" || !idPattern.test(row.id) ||
        !Array.isArray(row.after)) throw new TypeError("invalid task");
    if (ids.has(row.id)) throw new TypeError("duplicate task id");
    ids.add(row.id);
    const deps = new Set();
    for (const dep of row.after) {
      if (typeof dep !== "string" || !idPattern.test(dep) || dep === row.id || deps.has(dep)) {
        throw new TypeError("invalid dependency");
      }
      deps.add(dep);
    }
    rows.push({ id: row.id, deps: [...deps] });
  }

  const indegree = new Map();
  const dependents = new Map();
  for (const row of rows) {
    indegree.set(row.id, row.deps.length);
    dependents.set(row.id, []);
  }
  for (const row of rows) {
    for (const dep of row.deps) {
      if (!ids.has(dep)) throw new TypeError("unknown dependency");
      dependents.get(dep).push(row.id);
    }
  }

  let ready = rows.filter(row => indegree.get(row.id) === 0).map(row => row.id).sort();
  const layers = [];
  let processed = 0;
  while (ready.length) {
    const layer = ready;
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
  if (processed !== rows.length) throw new RangeError("task dependency cycle");
  return { order: layers.flat(), layers };
}
