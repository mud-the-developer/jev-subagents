export function planTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new TypeError("Tasks must be an array");
  }

  const idPattern = /^[a-z][a-z0-9_-]{0,31}$/;
  const graph = new Map();
  for (const task of tasks) {
    if (task === null || typeof task !== "object" || Array.isArray(task) ||
        !Object.prototype.hasOwnProperty.call(task, "id") ||
        !Object.prototype.hasOwnProperty.call(task, "after")) {
      throw new TypeError("Each task must be an object owning id and after");
    }
    const { id, after } = task;
    if (typeof id !== "string" || !idPattern.test(id) || !Array.isArray(after)) {
      throw new TypeError("Invalid task id or dependency array");
    }
    if (graph.has(id)) {
      throw new TypeError("Duplicate task id");
    }
    graph.set(id, { after, remaining: after.length, dependents: [] });
  }

  for (const [id, node] of graph) {
    const seen = new Set();
    for (const dependency of node.after) {
      if (typeof dependency !== "string" || !idPattern.test(dependency) ||
          dependency === id || seen.has(dependency) || !graph.has(dependency)) {
        throw new TypeError("Invalid, duplicate, unknown or self dependency");
      }
      seen.add(dependency);
      graph.get(dependency).dependents.push(id);
    }
  }

  const order = [];
  const layers = [];
  let ready = [];
  for (const [id, node] of graph) {
    if (node.remaining === 0) ready.push(id);
  }
  while (ready.length) {
    const layer = ready.sort();
    layers.push(layer);
    ready = [];
    for (const id of layer) {
      order.push(id);
      for (const dependent of graph.get(id).dependents) {
        const node = graph.get(dependent);
        node.remaining -= 1;
        if (node.remaining === 0) ready.push(dependent);
      }
    }
  }
  if (order.length !== graph.size) {
    throw new RangeError("Task dependencies contain a cycle");
  }
  return { order, layers };
}
