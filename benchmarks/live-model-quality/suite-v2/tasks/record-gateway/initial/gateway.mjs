import { canAccess, isValidUser } from "./policy.mjs";
export async function handle(request, repo) {
  if (!isValidUser(request?.user)) return { status: 401, body: null };
  const record = await repo.findById(request.id);
  if (!record) return { status: 404, body: null };
  if (!canAccess(request.user, request.method === "GET" ? "read" : "update", record)) return { status: 403, body: null };
  if (request.method === "PATCH") return { status: 200, body: await repo.updateTitle(request.id, request.body.title) };
  if (request.method === "DELETE") { await repo.delete(request.id); return { status: 204, body: null }; }
  return { status: 200, body: record };
}
