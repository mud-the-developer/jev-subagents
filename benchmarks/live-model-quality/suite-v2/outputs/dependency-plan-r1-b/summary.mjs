import { planTasks } from "./planner.mjs";

export function renderTaskPlan(tasks) {
  const { layers } = planTasks(tasks);
  return layers.length
    ? layers.map((layer, index) => `layer${index}: ${layer.join(", ")}`).join("\n")
    : "(empty)";
}
