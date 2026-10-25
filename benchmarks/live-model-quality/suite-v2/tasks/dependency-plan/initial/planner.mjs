export function planTasks(tasks) {
  const order = tasks.sort((a, b) => a.id.localeCompare(b.id)).map(row => row.id);
  return { order, layers: order.length ? [order] : [] };
}
