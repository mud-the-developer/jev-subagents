import { planTasks } from "./planner.mjs";

export function renderTaskPlan(tasks) {
  const { layers } = planTasks(tasks);
  if (layers.length === 0) return "(empty)";
  return layers.map((layer, index) => `layer${index}: ${layer.join(", ")}`).join("\n");
}
