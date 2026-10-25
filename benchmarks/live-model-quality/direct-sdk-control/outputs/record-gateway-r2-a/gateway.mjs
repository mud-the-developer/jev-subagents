import { canAccess, isValidUser } from "./policy.mjs";

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isValidId = (value) => typeof value === "string" && ID_RE.test(value);

export async function handle(request, repo) {
  if (!isObject(request)) return { status: 400, body: null };
  const { method } = request;
  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    return { status: 405, body: null };
  }
  if (!isValidUser(request.user)) return { status: 401, body: null };
  if (!hasOwn(request, "id") || !isValidId(request.id)) return { status: 400, body: null };

  let title;
  if (method === "PATCH") {
    const body = request.body;
    if (!isObject(body) || Object.keys(body).length !== 1 || Object.keys(body)[0] !== "title" ||
        !hasOwn(body, "title") || typeof body.title !== "string") return { status: 400, body: null };
    title = body.title.trim();
    if (title.length < 1 || title.length > 80) return { status: 400, body: null };
  }

  const record = await repo.findById(request.id);
  if (!record) return { status: 404, body: null };
  if (!isObject(record) || !hasOwn(record, "id") || record.id !== request.id) {
    return { status: 403, body: null };
  }
  const action = method === "GET" ? "read" : method === "PATCH" ? "update" : "delete";
  if (!canAccess(request.user, action, record)) return { status: 403, body: null };

  if (method === "GET") return { status: 200, body: { id: record.id, title: record.title } };
  if (method === "PATCH") {
    await repo.updateTitle(request.id, title);
    return { status: 200, body: { id: record.id, title } };
  }
  await repo.delete(request.id);
  return { status: 204, body: null };
}
