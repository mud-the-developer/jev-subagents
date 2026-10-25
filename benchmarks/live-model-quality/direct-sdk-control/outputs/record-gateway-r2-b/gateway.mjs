import { canAccess, isValidUser } from "./policy.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.exec(value)?.[0] === value;
}

export async function handle(request, repo) {
  if (!isObject(request)) return { status: 400, body: null };
  const { method, user, id } = request;
  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    return { status: 405, body: null };
  }
  if (!isValidUser(user)) return { status: 401, body: null };
  if (!isValidId(id)) return { status: 400, body: null };

  let title;
  if (method === "PATCH") {
    const { body } = request;
    if (!isObject(body)) return { status: 400, body: null };
    const keys = Reflect.ownKeys(body).filter(key =>
      Object.prototype.propertyIsEnumerable.call(body, key));
    if (keys.length !== 1 || keys[0] !== "title" || typeof body.title !== "string") {
      return { status: 400, body: null };
    }
    title = body.title.trim();
    if (title.length < 1 || title.length > 80) return { status: 400, body: null };
  }

  const record = await repo.findById(id);
  if (record == null) return { status: 404, body: null };
  const action = method === "GET" ? "read" : method === "PATCH" ? "update" : "delete";
  if (record.id !== id || !canAccess(user, action, record)) {
    return { status: 403, body: null };
  }

  if (method === "PATCH") {
    await repo.updateTitle(id, title);
    return { status: 200, body: { id, title } };
  }
  if (method === "DELETE") {
    await repo.delete(id);
    return { status: 204, body: null };
  }
  return { status: 200, body: { id, title: record.title } };
}
