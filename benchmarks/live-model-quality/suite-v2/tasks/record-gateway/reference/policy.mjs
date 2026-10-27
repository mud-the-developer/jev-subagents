const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const owns = (value, names) => names.every(name => Object.hasOwn(value, name));
export function isValidUser(user) {
  return object(user) && owns(user, ["id", "role"]) && id(user.id) && ["member", "admin"].includes(user.role);
}
export function canAccess(user, action, record) {
  if (!isValidUser(user) || !["read", "update", "delete"].includes(action) || !object(record) || !owns(record, ["id", "ownerId", "title", "archived"]) || !id(record.id) || !id(record.ownerId) || typeof record.title !== "string" || typeof record.archived !== "boolean") return false;
  if (action === "delete") return user.role === "admin" && record.archived;
  return user.role === "admin" || record.ownerId === user.id;
}
