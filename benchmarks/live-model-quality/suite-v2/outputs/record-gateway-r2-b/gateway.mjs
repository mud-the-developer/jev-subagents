import { canAccess, isValidUser } from "./policy.mjs";

export async function handle(request, repo) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return { status: 400, body: null };
  }

  const { method, user, id } = request;
  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    return { status: 405, body: null };
  }
  if (!isValidUser(user)) return { status: 401, body: null };
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
    return { status: 400, body: null };
  }

  let trimmedTitle;
  if (method === "PATCH") {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { status: 400, body: null };
    }
    const keys = Reflect.ownKeys(body).filter(key =>
      Object.prototype.propertyIsEnumerable.call(body, key));
    if (keys.length !== 1 || keys[0] !== "title" || typeof body.title !== "string") {
      return { status: 400, body: null };
    }
    trimmedTitle = body.title.trim();
    if (trimmedTitle.length < 1 || trimmedTitle.length > 80) {
      return { status: 400, body: null };
    }
  }

  const record = await repo.findById(id);
  if (record === null || record === undefined) return { status: 404, body: null };
  const action = method === "GET" ? "read" : method === "PATCH" ? "update" : "delete";
  if (record.id !== id || !canAccess(user, action, record)) {
    return { status: 403, body: null };
  }

  if (method === "GET") {
    return { status: 200, body: { id, title: record.title } };
  }
  if (method === "PATCH") {
    await repo.updateTitle(id, trimmedTitle);
    return { status: 200, body: { id, title: trimmedTitle } };
  }
  await repo.delete(id);
  return { status: 204, body: null };
}
