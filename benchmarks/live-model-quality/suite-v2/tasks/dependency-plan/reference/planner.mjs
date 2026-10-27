export function planTasks(tasks) {
  const validId = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
  if (!Array.isArray(tasks)) throw new TypeError("Invalid tasks");
  const dependencies = new Map();
  for (const row of tasks) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !Object.hasOwn(row, "id") || !Object.hasOwn(row, "after") || !validId(row.id) || !Array.isArray(row.after) || row.after.some(id => !validId(id)) || new Set(row.after).size !== row.after.length || dependencies.has(row.id)) throw new TypeError("Invalid task");
    dependencies.set(row.id, new Set(row.after));
  }
  for (const [id, after] of dependencies) for (const parent of after) if (parent === id || !dependencies.has(parent)) throw new TypeError("Invalid dependency");
  const layers = [], order = [];
  while (dependencies.size) {
    const layer = [...dependencies].filter(([, after]) => after.size === 0).map(([id]) => id).sort();
    if (!layer.length) throw new RangeError("Dependency cycle");
    layers.push(layer); order.push(...layer);
    for (const id of layer) dependencies.delete(id);
    for (const after of dependencies.values()) for (const id of layer) after.delete(id);
  }
  return { order, layers };
}
