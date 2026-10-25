export function planTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new TypeError("Tasks must be an array");
  }

  // Comparing the whole match also excludes trailing line terminators.
  const isId = value =>
    typeof value === "string" &&
    /^[a-z][a-z0-9_-]{0,31}$/.exec(value)?.[0] === value;
  const nodes = new Map();

  for (const row of tasks) {
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !Object.prototype.hasOwnProperty.call(row, "id") ||
      !Object.prototype.hasOwnProperty.call(row, "after") ||
      !isId(row.id) ||
      !Array.isArray(row.after)
    ) {
      throw new TypeError("Invalid task");
    }
    if (nodes.has(row.id)) {
      throw new TypeError("Duplicate task ID");
    }

    const after = new Set();
    for (const dependency of row.after) {
      if (!isId(dependency) || dependency === row.id || after.has(dependency)) {
        throw new TypeError("Invalid or duplicate dependency");
      }
      after.add(dependency);
    }
    nodes.set(row.id, { after, remaining: after.size, dependents: [] });
  }

  for (const [id, node] of nodes) {
    for (const dependency of node.after) {
      const prerequisite = nodes.get(dependency);
      if (!prerequisite) {
        throw new TypeError("Unknown dependency");
      }
      prerequisite.dependents.push(id);
    }
  }

  let ready = [];
  for (const [id, node] of nodes) {
    if (node.remaining === 0) ready.push(id);
  }

  const order = [];
  const layers = [];
  while (ready.length > 0) {
    ready.sort();
    layers.push(ready);
    const next = [];
    for (const id of ready) {
      order.push(id);
      for (const dependent of nodes.get(id).dependents) {
        const node = nodes.get(dependent);
        node.remaining -= 1;
        if (node.remaining === 0) next.push(dependent);
      }
    }
    ready = next;
  }

  if (order.length !== nodes.size) {
    throw new RangeError("Cyclic task dependencies");
  }
  return { order, layers };
}
