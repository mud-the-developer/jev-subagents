import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, chmod, rm } from "node:fs/promises";
import type { TestContext } from "node:test";
import path from "node:path";
import type { VerificationContainer } from "../../src/goal-verification.ts";

export const IMAGE = `sha256:${"b".repeat(64)}`;
export type Container = { id: string; body: VerificationContainer; running: boolean; started: boolean; exit: number; removed: boolean };
export type DockerRequest = { method: string; route: string; body: unknown };
/** Protocol fixture only: it does NOT execute containers or establish kernel isolation. */
export async function dockerFixture(t: TestContext, mode = "ok", onWait?: (container: Container) => Promise<number> | number) {
  const root = await realpath(await mkdtemp("/tmp/jev-docker-")), socketPath = path.join(root, "api.sock");
  const requests: DockerRequest[] = [], containers: Container[] = [];
  let waited = () => {};
  const waiting = new Promise<void>((resolve) => { waited = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const route = req.url!.slice("/v1.47".length), method = req.method!;
    assert.ok(req.url!.startsWith("/v1.47/"));
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method, route, body });
    const send = (code: number, value?: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (route === "/info") {
      if (mode === "http") { send(500, { error: "PRIVATE_DOCKER_ERROR" }); return; }
      if (mode === "oversized") { res.end('"' + "x".repeat(65536) + '"'); return; }
      if (mode === "utf8") { res.end(Buffer.from([0xff])); return; }
      send(200, { OSType: "linux", CgroupVersion: "2", MemoryLimit: mode !== "unsupported", SwapLimit: true, PidsLimit: true, CpuCfsQuota: true,
        SecurityOptions: ["name=seccomp,profile=builtin"], SystemTime: new Date(Date.now() + (mode === "clock" ? 60_000 : 0)).toISOString() }); return;
    }
    if (route.startsWith("/images/")) { send(200, { Id: IMAGE, Os: "linux", Config: { Env: ["PATH=/unapproved", "PRIVATE_IMAGE_ENV=DO_NOT_INHERIT"], Volumes: mode === "volume" ? { "/data": {} } : null } }); return; }
    if (route.startsWith("/containers/create?")) {
      const id = (containers.length + 1).toString(16).padStart(64, "a");
      containers.push({ id, body, running: false, started: false, exit: 0, removed: false });
      if (mode === "lost_create") { req.socket.destroy(); return; }
      send(201, { Id: id, Warnings: mode === "warning" ? ["Unsupported limit"] : [] }); return;
    }
    const id = route.split("?")[0]!.split("/")[2], container = containers.find((item) => item.id === id && !item.removed);
    if (!container) { send(404, { error: "Not found" }); return; }
    if (route.endsWith("/json")) {
      const inspect = { Id: id, Image: IMAGE, Config: { ...container.body }, HostConfig: structuredClone(container.body.HostConfig),
        Mounts: container.body.HostConfig.Mounts.map((mount) => ({ Type: "bind", Source: mount.Source, Destination: mount.Target, RW: false, Propagation: "rprivate" })),
        State: { Status: container.running ? "running" : container.started ? "exited" : "created", Running: container.running, Pid: container.running ? 123 : 0,
          Paused: false, Dead: false, OOMKilled: mode === "oom", ExitCode: container.exit, StartedAt: container.started ? new Date().toISOString() : "0001-01-01T00:00:00Z" } };
      if (mode === "isolation") inspect.HostConfig.NetworkMode = "bridge";
      if (mode === "foreign") inspect.Config.Labels = { foreign: "owner" };
      if (mode === "wait_mismatch" && container.started) inspect.State.ExitCode = 2;
      send(200, inspect); return;
    }
    if (route.endsWith("/start")) { container.running = true; container.started = true; send(204); return; }
    if (route.includes("/wait?")) {
      waited();
      if (mode === "hold" && container.running) return;
      container.exit = container.running ? await onWait?.(container) ?? 0 : container.exit;
      container.running = false;
      send(200, { StatusCode: container.exit }); return;
    }
    if (route.includes("/kill?")) { container.running = false; container.exit = 137; send(204); return; }
    if (method === "DELETE") {
      if (mode === "remove") { send(500, { error: "PRIVATE_REMOVE_ERROR" }); return; }
      assert.equal(container.running, false); container.removed = true; send(204); return;
    }
    send(400, { error: "Unexpected API operation" });
  });
  server.listen(socketPath); await once(server, "listening"); await chmod(socketPath, 0o600);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { root, socketPath, requests, containers, waiting };
}
