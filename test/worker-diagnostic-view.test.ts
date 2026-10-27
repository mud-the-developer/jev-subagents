import assert from "node:assert/strict";
import { test } from "node:test";
import { workerDiagnosticView } from "../src/worker-diagnostic-view.ts";
import { WorkerReportSchema } from "../src/delegate-machine.ts";

const empty = { cause: undefined, stage: undefined, httpStatus: undefined };
test("worker diagnostic projection uses fixed categories and every supported report stage", () => {
  for (const item of WorkerReportSchema.properties.diagnostic.properties.category.anyOf) {
    assert.equal(typeof workerDiagnosticView({ category: item.const }).cause, "string");
  }
  for (const item of WorkerReportSchema.properties.diagnostic.properties.stage.anyOf) {
    assert.equal(typeof workerDiagnosticView({ stage: item.const }).stage, "string");
  }
  const input = { category: "authentication", httpStatus: 401, stage: "model_request", message: "PRIVATE_PROVIDER_BODY" };
  const before = structuredClone(input);
  assert.deepEqual(workerDiagnosticView(input), { cause: "Check authentication", stage: "Model request", httpStatus: 401 });
  assert.deepEqual(input, before); assert.equal(JSON.stringify(workerDiagnosticView(input)).includes("PRIVATE"), false);
});

test("diagnostic getters, inherited values and private labels are not read or displayed", () => {
  let getters = 0;
  const hostile = Object.defineProperties({}, Object.fromEntries(["category", "stage", "httpStatus"].map(key => [key, { get() { getters++; throw new Error("PRIVATE_GETTER"); } }])));
  assert.deepEqual(workerDiagnosticView(hostile), empty); assert.equal(getters, 0);
  assert.deepEqual(workerDiagnosticView(Object.create({ category: "authentication", stage: "cleanup", httpStatus: 401 })), empty);
  for (const value of [null, undefined, [], "PRIVATE", { category: "__proto__", stage: "constructor", httpStatus: "401" },
    { category: "PRIVATE\nFORGED", stage: "model_request\u001b[2J", httpStatus: NaN }]) assert.deepEqual(workerDiagnosticView(value), empty);
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("PRIVATE_PROXY"); } });
  assert.deepEqual(workerDiagnosticView(throwing), empty);
});

test("HTTP 200 incomplete-response labels reveal no provider body or completion claim", () => {
  const result = workerDiagnosticView({ category: "response_incomplete", stage: "model_response", httpStatus: 200, error: "PRIVATE_PROVIDER_BODY" });
  assert.deepEqual(result, { cause: "Incomplete model response", stage: "Model response/stop format", httpStatus: 200 });
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("only actual bounded integer HTTP statuses are reported, never coerced into success", () => {
  for (const value of [99, 600, 401.5, Infinity, NaN, "401", null, undefined]) assert.equal(workerDiagnosticView({ httpStatus: value }).httpStatus, undefined);
  for (const value of [100, 200, 401, 429, 599]) assert.equal(workerDiagnosticView({ httpStatus: value }).httpStatus, value);
});
