import { canAccess, isValidUser } from "./policy.mjs";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const idPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const methods = new Set(["GET", "PATCH", "DELETE"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidId(value) {
  return typeof value === "string" && idPattern.test(value);
}

function isValidBody(body) {
  if (!isObject(body)) return false;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "title" &&
    typeof body.title === "string" && body.title.trim().length >= 1 && body.title.trim().length <= 80;
}

export async function handle(request, repo) {
  if (!isObject(request)) return { status: 400, body: null };
  if (!methods.has(request.method)) return { status: 405, body: null };
  if (!isValidUser(request.user)) return { status: 401, body: null };
  if (!hasOwn(request, "id") || !isValidId(request.id)) return { status: 400, body: null };
  if (request.method === "PATCH" && !isValidBody(request.body)) return { status: 400, body: null };

  const record = await repo.findById(request.id);
  if (!record) return { status: 404, body: null };
  if (!isObject(record) || !hasOwn(record, "id") || record.id !== request.id) return { status: 403, body: null };

  const action = request.method === "GET" ? "read" : request.method === "PATCH" ? "update" : "delete";
  if (!canAccess(request.user, action, record)) return { status: 403, body: null };
  if (request.method === "GET") return { status: 200, body: { id: record.id, title: record.title } };
  if (request.method === "PATCH") {
    const title = request.body.title.trim();
    await repo.updateTitle(request.id, title);
    return { status: 200, body: { id: request.id, title } };
  }
  await repo.delete(request.id);
  return { status: 204, body: null };
}
