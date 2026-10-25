const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function planTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");

  const rows = new Map();
  for (const row of tasks) {
    if (row === null || typeof row !== "object" || Array.isArray(row) || !own(row, "id") || !own(row, "after")) {
      throw new TypeError("invalid task row");
    }
    if (typeof row.id !== "string" || !ID_RE.test(row.id)) throw new TypeError("invalid task id");
    if (rows.has(row.id)) throw new TypeError("duplicate task id");
    if (!Array.isArray(row.after)) throw new TypeError("invalid dependencies");
    const deps = new Set();
    for (const dep of row.after) {
      if (typeof dep !== "string" || !ID_RE.test(dep) || deps.has(dep)) {
        throw new TypeError("invalid dependency");
      }
      deps.add(dep);
    }
    rows.set(row.id, deps);
  }

  const indegree = new Map();
  const dependents = new Map();
  for (const id of rows.keys()) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const [id, deps] of rows) {
    for (const dep of deps) {
      if (dep === id || !rows.has(dep)) throw new TypeError("invalid dependency");
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(dep).push(id);
    }
  }

  let ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const layers = [];
  let processed = 0;
  while (ready.length) {
    const layer = ready.slice().sort();
    layers.push(layer);
    processed += layer.length;
    const next = [];
    for (const id of layer) {
      for (const child of dependents.get(id)) {
        const degree = indegree.get(child) - 1;
        indegree.set(child, degree);
        if (degree === 0) next.push(child);
      }
    }
    ready = next.sort();
  }
  if (processed !== rows.size) throw new RangeError("cyclic dependencies");
  return { order: layers.flat(), layers };
}
