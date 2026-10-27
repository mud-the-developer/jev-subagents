import { canAccess, isValidUser } from "./policy.mjs";
export async function handle(request, repo) {
  const response = (status, body = null) => ({ status, body });
  if (!request || typeof request !== "object" || Array.isArray(request)) return response(400);
  if (!["GET", "PATCH", "DELETE"].includes(request.method)) return response(405);
  if (!isValidUser(request.user)) return response(401);
  if (typeof request.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(request.id)) return response(400);
  let title;
  if (request.method === "PATCH") {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "title") || typeof body.title !== "string" || body.title.trim().length < 1 || body.title.trim().length > 80) return response(400);
    title = body.title.trim();
  }
  const record = await repo.findById(request.id);
  if (record == null) return response(404);
  const action = { GET: "read", PATCH: "update", DELETE: "delete" }[request.method];
  if (record.id !== request.id || !canAccess(request.user, action, record)) return response(403);
  if (request.method === "GET") return response(200, { id: record.id, title: record.title });
  if (request.method === "PATCH") { await repo.updateTitle(request.id, title); return response(200, { id: request.id, title }); }
  await repo.delete(request.id); return response(204);
}
