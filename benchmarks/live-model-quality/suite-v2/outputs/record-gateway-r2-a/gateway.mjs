import { canAccess, isValidUser } from "./policy.mjs";

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

function validPatchBody(body) {
  if (!isObject(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "title" &&
    typeof body.title === "string" && body.title.trim().length >= 1 &&
    body.title.trim().length <= 80;
}

export async function handle(request, repo) {
  if (!isObject(request)) return { status: 400, body: null };
  const method = request.method;
  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    return { status: 405, body: null };
  }
  if (!isValidUser(request.user)) return { status: 401, body: null };
  if (!validId(request.id)) return { status: 400, body: null };
  if (method === "PATCH" && !validPatchBody(request.body)) {
    return { status: 400, body: null };
  }

  const record = await repo.findById(request.id);
  if (!record) return { status: 404, body: null };
  if (!isObject(record) || record.id !== request.id) return { status: 403, body: null };

  const action = method === "GET" ? "read" : method === "PATCH" ? "update" : "delete";
  if (!canAccess(request.user, action, record)) return { status: 403, body: null };
  if (method === "GET") {
    return { status: 200, body: { id: record.id, title: record.title } };
  }
  if (method === "PATCH") {
    const title = request.body.title.trim();
    await repo.updateTitle(request.id, title);
    return { status: 200, body: { id: request.id, title } };
  }
  await repo.delete(request.id);
  return { status: 204, body: null };
}
