import { planTasks } from "./planner.mjs";
export function renderTaskPlan(tasks) {
  const { layers } = planTasks(tasks);
  return layers.length ? layers.map((ids, index) => `layer${index}: ${ids.join(", ")}`).join("\n") : "(empty)";
}
