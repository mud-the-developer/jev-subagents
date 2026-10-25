import { planTasks } from "./planner.mjs";
export function renderTaskPlan(tasks) { return "tasks: " + planTasks(tasks).order.join(", "); }
