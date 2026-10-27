const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function planTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");

  const ids = new Set();
  const rows = [];
  for (const row of tasks) {
    if (row === null || typeof row !== "object" || Array.isArray(row) ||
        !Object.prototype.hasOwnProperty.call(row, "id") ||
        !Object.prototype.hasOwnProperty.call(row, "after") ||
        typeof row.id !== "string" || !ID_RE.test(row.id) ||
        !Array.isArray(row.after)) {
      throw new TypeError("malformed task");
    }
    if (ids.has(row.id)) throw new TypeError("duplicate task id");
    ids.add(row.id);
    const deps = [];
    const seen = new Set();
    for (const dep of row.after) {
      if (typeof dep !== "string" || !ID_RE.test(dep) || seen.has(dep)) {
        throw new TypeError("malformed dependency");
      }
      seen.add(dep);
      deps.push(dep);
    }
    rows.push({ id: row.id, deps });
  }

  const indegree = new Map();
  const dependents = new Map();
  for (const { id } of rows) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const { id, deps } of rows) {
    for (const dep of deps) {
      if (!ids.has(dep) || dep === id) throw new TypeError("invalid dependency");
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(dep).push(id);
    }
  }

  const layers = [];
  let ready = rows.filter(({ id }) => indegree.get(id) === 0).map(({ id }) => id).sort();
  let count = 0;
  while (ready.length) {
    const layer = ready.slice();
    layers.push(layer);
    count += layer.length;
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
  if (count !== rows.length) throw new RangeError("task dependency cycle");
  return { order: layers.flat(), layers };
}
