import assert from "node:assert/strict";
import { planTasks } from "./planner.mjs";
import { renderTaskPlan } from "./summary.mjs";
const frozen = rows => Object.freeze(rows.map(row => Object.freeze({ ...row, after: Object.freeze([...row.after]) })));
const cases = [
  ["empty_plan", () => assert.deepEqual(planTasks([]), { order: [], layers: [] })],
  ["parallel_layer_ascii_order", () => assert.deepEqual(planTasks([{ id: "a_", after: [] }, { id: "a0", after: [] }, { id: "a-", after: [] }, { id: "a", after: [] }]), { order: ["a", "a-", "a0", "a_"], layers: [["a", "a-", "a0", "a_"]] })],
  ["dependencies_override_input_order", () => assert.deepEqual(planTasks([{ id: "a", after: ["z"] }, { id: "z", after: [] }]), { order: ["z", "a"], layers: [["z"], ["a"]] })],
  ["layer_batch_not_priority_queue", () => assert.deepEqual(planTasks([{ id: "aa", after: ["b"] }, { id: "b", after: [] }, { id: "a", after: [] }]), { order: ["a", "b", "aa"], layers: [["a", "b"], ["aa"]] })],
  ["diamond_layers", () => assert.deepEqual(planTasks([{ id: "d", after: ["c", "b"] }, { id: "c", after: ["a"] }, { id: "a", after: [] }, { id: "b", after: ["a"] }]), { order: ["a", "b", "c", "d"], layers: [["a"], ["b", "c"], ["d"]] })],
  ["frozen_input_not_mutated", () => {
    const rows = frozen([{ id: "c", after: ["b", "a"], metadata: "synthetic" }, { id: "b", after: [] }, { id: "a", after: [] }]), before = JSON.stringify(rows);
    assert.deepEqual(planTasks(rows), { order: ["a", "b", "c"], layers: [["a", "b"], ["c"]] }); assert.equal(JSON.stringify(rows), before);
  }],
  ["fresh_output_arrays", () => {
    const rows = [{ id: "a", after: [] }, { id: "b", after: ["a"] }], a = planTasks(rows), b = planTasks(rows);
    assert.notEqual(a.order, b.order); assert.notEqual(a.layers, b.layers); assert.notEqual(a.order, a.layers[0]);
    for (const layer of a.layers) assert.ok(rows.every(row => row.after !== layer));
    a.layers[0].push("modified"); assert.deepEqual(b.order, ["a", "b"]); assert.deepEqual(rows[0].after, []);
  }],
  ["malformed_rows_and_ids", () => {
    for (const rows of [null, {}, "a", [null], [[]], [{}], [{ id: "A", after: [] }], [{ id: "", after: [] }], [{ id: "a", after: null }], [{ id: "a", after: [1] }], [Object.create({ id: "a", after: [] })]]) assert.throws(() => planTasks(rows), TypeError);
  }],
  ["duplicate_task_ids", () => assert.throws(() => planTasks([{ id: "a", after: [] }, { id: "a", after: [] }]), TypeError)],
  ["duplicate_dependency_ids", () => assert.throws(() => planTasks([{ id: "a", after: [] }, { id: "b", after: ["a", "a"] }]), TypeError)],
  ["unknown_dependency", () => assert.throws(() => planTasks([{ id: "a", after: ["missing"] }]), TypeError)],
  ["self_dependency", () => assert.throws(() => planTasks([{ id: "a", after: ["a"] }]), TypeError)],
  ["cycle_rejects_range_error", () => assert.throws(() => planTasks([{ id: "a", after: ["b"] }, { id: "b", after: ["a"] }]), RangeError)],
  ["cycle_with_ready_nodes_never_partial", () => assert.throws(() => planTasks([{ id: "free", after: [] }, { id: "a", after: ["b"] }, { id: "b", after: ["a"] }]), RangeError)],
  ["render_empty_and_nonempty_exactly", () => {
    assert.equal(renderTaskPlan([]), "(empty)");
    assert.equal(renderTaskPlan([{ id: "c", after: ["b", "a"] }, { id: "b", after: [] }, { id: "a", after: [] }]), "layer0: a, b\nlayer1: c");
  }],
  ["render_preserves_planner_errors", () => {
    assert.throws(() => renderTaskPlan([{ id: "a", after: ["missing"] }]), TypeError);
    assert.throws(() => renderTaskPlan([{ id: "a", after: ["b"] }, { id: "b", after: ["a"] }]), RangeError);
  }],
  ["seeded_dag_depth_oracle", () => {
    let seed = 0x6a09e667;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let n = 0; n < 200; n++) {
      const size = 1 + rand() % 9, rows = [], depths = [];
      for (let i = 0; i < size; i++) {
        const after = []; for (let j = 0; j < i; j++) if (rand() % 3 === 0) after.push(`t${j}`);
        depths[i] = after.length ? 1 + Math.max(...after.map(id => depths[Number(id.slice(1))])) : 0;
        rows.push({ id: `t${i}`, after });
      }
      const layers = [];
      for (let i = 0; i < size; i++) (layers[depths[i]] ??= []).push(`t${i}`);
      for (const layer of layers) layer.sort(); rows.reverse();
      assert.deepEqual(planTasks(frozen(rows)), { order: layers.flat(), layers });
    }
  }],
];
const results = [];
for (const [name, check] of cases) { try { await check(); results.push({ name, passed: true }); } catch { results.push({ name, passed: false }); } }
const passed = results.filter(value => value.passed).length;
console.log(JSON.stringify({ task: "dependency-plan", total: cases.length, passed, failed: cases.length - passed, results }));
if (passed !== cases.length) process.exitCode = 1;
