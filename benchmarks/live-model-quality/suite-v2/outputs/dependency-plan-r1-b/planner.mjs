export function planTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");

  // Require the true end of the ID, including when it ends in a line break.
  const isId = id =>
    typeof id === "string" && /^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(id);
  const nodes = new Map();

  for (const task of tasks) {
    if (
      task === null || typeof task !== "object" || Array.isArray(task) ||
      !Object.prototype.hasOwnProperty.call(task, "id") ||
      !Object.prototype.hasOwnProperty.call(task, "after") ||
      !isId(task.id) || !Array.isArray(task.after)
    ) {
      throw new TypeError("Invalid task");
    }
    if (nodes.has(task.id)) throw new TypeError("Duplicate task ID");
    nodes.set(task.id, {
      after: task.after,
      remaining: task.after.length,
      dependents: []
    });
  }

  for (const [id, node] of nodes) {
    const seen = new Set();
    for (const dependency of node.after) {
      if (
        !isId(dependency) || dependency === id ||
        seen.has(dependency) || !nodes.has(dependency)
      ) {
        throw new TypeError("Invalid dependency");
      }
      seen.add(dependency);
      nodes.get(dependency).dependents.push(id);
    }
  }

  let ready = [];
  for (const [id, node] of nodes) {
    if (node.remaining === 0) ready.push(id);
  }

  const order = [];
  const layers = [];
  while (ready.length) {
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

  if (order.length !== tasks.length) throw new RangeError("Cyclic task dependencies");
  return { order, layers };
}
