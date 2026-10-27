export function planTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("Tasks must be an array");

  const isId = id => typeof id === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(id);
  const nodes = new Map();
  for (const task of tasks) {
    if (task === null || typeof task !== "object" || Array.isArray(task) ||
        !Object.prototype.hasOwnProperty.call(task, "id") ||
        !Object.prototype.hasOwnProperty.call(task, "after") ||
        !isId(task.id) || !Array.isArray(task.after)) {
      throw new TypeError("Invalid task");
    }
    if (nodes.has(task.id)) throw new TypeError("Duplicate task ID");

    const after = new Set();
    for (const id of task.after) {
      if (!isId(id) || after.has(id) || id === task.id) {
        throw new TypeError("Invalid dependency");
      }
      after.add(id);
    }
    nodes.set(task.id, { after, remaining: after.size, dependents: [] });
  }

  for (const [id, node] of nodes) {
    for (const dependency of node.after) {
      const parent = nodes.get(dependency);
      if (!parent) throw new TypeError("Unknown dependency");
      parent.dependents.push(id);
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
    // Collect newly ready tasks separately to preserve complete layer boundaries.
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

  if (order.length !== nodes.size) throw new RangeError("Dependency cycle");
  return { order, layers };
}
