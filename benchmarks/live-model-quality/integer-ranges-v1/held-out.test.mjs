import assert from "node:assert/strict";
import { mergeClosedIntegerRanges as merge } from "./ranges.mjs";

const cases = [
  ["empty", () => assert.deepEqual(merge([]), [])],
  ["overlap", () => assert.deepEqual(merge([[1, 4], [3, 8]]), [[1, 8]])],
  ["adjacent_chain", () => assert.deepEqual(merge([[4, 6], [1, 2], [3, 3]]), [[1, 6]])],
  ["contained_does_not_shrink", () => assert.deepEqual(merge([[1, 10], [2, 3], [12, 12]]), [[1, 10], [12, 12]])],
  ["unsorted_disjoint", () => assert.deepEqual(merge([[10, 12], [1, 2], [5, 6]]), [[1, 2], [5, 6], [10, 12]])],
  ["negative_and_zero", () => assert.deepEqual(merge([[-3, -1], [0, 0], [-8, -6]]), [[-8, -6], [-3, 0]])],
  ["duplicates", () => assert.deepEqual(merge([[1, 2], [1, 2], [1, 1]]), [[1, 2]])],
  ["input_unchanged", () => {
    const input = [[8, 9], [1, 3], [2, 4]], before = structuredClone(input);
    assert.deepEqual(merge(input), [[1, 4], [8, 9]]); assert.deepEqual(input, before);
  }],
  ["frozen_input", () => assert.deepEqual(merge(Object.freeze([Object.freeze([4, 5]), Object.freeze([1, 3])])), [[1, 5]])],
  ["fresh_result_pairs", () => {
    const input = [[1, 3], [8, 9]], result = merge(input);
    assert.notEqual(result, input); for (const pair of result) assert.ok(!input.includes(pair));
    result[0][0] = -10; assert.equal(input[0][0], 1);
  }],
  ["safe_integer_boundaries", () => {
    const min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER;
    assert.deepEqual(merge([[max - 1, max], [max - 2, max - 2], [min, min + 1], [min + 2, min + 3]]), [[min, min + 3], [max - 2, max]]);
  }],
  ["invalid_inputs", () => {
    for (const input of [null, undefined, {}, "1,2", [1, 2], [[1]], [[2, 1]], [[0, 1, 2]], [[1.5, 2]], [[0, Infinity]], [[NaN, 2]], [[0, Number.MAX_SAFE_INTEGER + 1]], [["1", 2]], [null]])
      assert.throws(() => merge(input), TypeError);
  }],
];
let passed = 0;
const results = cases.map(([name, check]) => {
  try { check(); passed++; return { name, passed: true }; }
  catch { return { name, passed: false }; }
});
console.log(JSON.stringify({ kind: "synthetic_quality_assertions", total: cases.length, passed, failed: cases.length - passed, results, liveCalls: 0 }));
if (passed !== cases.length) process.exitCode = 1;
