import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { beforeEach, test, type TestContext } from "node:test";
import { requestJev, route } from "../src/effects.ts";
import { JEV_MODEL } from "../src/machine.ts";

const nativeFetch = globalThis.fetch;
const request = { task: "Bounded offline fixture", agents: [
  { name: "a", description: "First fixture option" }, { name: "b", description: "Second fixture option" },
] };
const body = { model: JEV_MODEL, usage: { input_tokens: 31, output_tokens: 7 },
  answers: { agent: { type: "choice", choice: "a", confidence: 0.2, probabilities: { a: 0.75, b: 0.25 } } } };

beforeEach((t) => {
  assert.ok("mock" in t);
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "offline-transport-key";
  t.after(() => { if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External HTTP forbidden."); });
});

async function fixture(t: TestContext, handler: RequestListener) {
  const paths: string[] = [];
  const server = createServer((req, res) => { paths.push(req.url ?? ""); handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let receivedHeaders: () => void = () => {};
  const headers = new Promise<void>((resolve) => { receivedHeaders = resolve; });
  const http = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const response = await nativeFetch(`http://127.0.0.1:${address.port}/judgment`, init);
    receivedHeaders();
    return response;
  });
  return { paths, headers, http };
}

test("native JEV HTTP preserves the exact bounded packet and accepts a split UTF-8 response at 64 KiB", { timeout: 5_000 }, async (t) => {
  let packet: unknown;
  let authorization: string | undefined;
  const text = JSON.stringify({ ...body, ignored: "한" });
  const bytes = Buffer.from(text + " ".repeat(65_536 - Buffer.byteLength(text)));
  const split = bytes.indexOf(Buffer.from("한")) + 1;
  const { http, paths } = await fixture(t, (req, res) => {
    authorization = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(bytes.subarray(0, split));
      setImmediate(() => res.end(bytes.subarray(split)));
    });
  });
  const questions = { agent: { type: "choice", instructions: "Choose only a supplied fixture option.",
    criteria: { a: request.agents[0]!.description, b: request.agents[1]!.description } } };
  const response = await requestJev(request.task, questions);
  assert.equal(response.type, "response");
  if (response.type === "response") assert.deepEqual(response.body, { ...body, ignored: "한" });
  assert.equal(authorization, "Bearer offline-transport-key");
  assert.equal(bytes.length, 65_536);
  assert.deepEqual(packet, { model: JEV_MODEL, state: request.task, questions });
  assert.equal(http.mock.callCount(), 1);
  assert.deepEqual(paths, ["/judgment"]);
  assert.ok(!JSON.stringify(response).includes("offline-transport-key"));
});

test("native JEV HTTP rejects redirects, oversized bodies and HTTP failures without retry or baseline fallback", { timeout: 5_000 }, async (t) => {
  for (const mode of ["redirect", "oversized", "error"] as const) {
    const { http, paths } = await fixture(t, (_req, res) => {
      if (mode === "redirect") res.writeHead(307, { Location: "/forbidden-target" });
      else res.writeHead(mode === "error" ? 429 : 200, { "Content-Type": "application/json" });
      if (mode === "oversized") {
        const text = JSON.stringify({ ...body, ignored: "한" });
        res.end(text + " ".repeat(65_537 - Buffer.byteLength(text)));
      } else res.end("private-response-marker offline-transport-key");
    });
    const state = await route({ ...request, softRouting: { baseline: "b" } });
    assert.equal(state.status, "failed");
    assert.equal(http.mock.callCount(), 1);
    assert.deepEqual(paths, ["/judgment"]);
    assert.ok(!JSON.stringify(state).includes("private-response-marker"));
    assert.ok(!JSON.stringify(state).includes("offline-transport-key"));
    if (mode === "error" && state.status === "failed") assert.match(state.error, /HTTP 429/);
    http.mock.restore();
  }
});

test("native JEV HTTP aborts stalled response bodies on caller cancellation and the configured deadline", { timeout: 5_000 }, async (t) => {
  for (const timedOut of [false, true]) {
    const controller = new AbortController();
    const timeout = timedOut ? t.mock.method(AbortSignal, "timeout", (ms: number) => {
      assert.equal(ms, 10_000);
      return controller.signal;
    }) : undefined;
    const { http, paths, headers } = await fixture(t, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"model":"private-response-marker'); // Deliberately never complete the body.
    });
    const pending = route(request, timedOut ? undefined : controller.signal);
    await headers;
    controller.abort();
    const state = await pending;
    assert.equal(state.status, timedOut ? "failed" : "cancelled");
    if (timedOut && state.status === "failed") assert.match(state.error, /timed out after 10 seconds/);
    assert.equal(http.mock.callCount(), 1);
    assert.deepEqual(paths, ["/judgment"]);
    assert.ok(!JSON.stringify(state).includes("private-response-marker"));
    http.mock.restore();
    timeout?.mock.restore();
  }
});
