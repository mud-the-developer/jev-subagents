function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.exec(value)?.[0] === value;
}

export function isValidUser(user) {
  return isObject(user) && hasOwn(user, "id") && hasOwn(user, "role") &&
    isValidId(user.id) && (user.role === "member" || user.role === "admin");
}

function isValidRecord(record) {
  return isObject(record) &&
    ["id", "ownerId", "title", "archived"].every(key => hasOwn(record, key)) &&
    isValidId(record.id) && isValidId(record.ownerId) &&
    typeof record.title === "string" && typeof record.archived === "boolean";
}

export function canAccess(user, action, record) {
  if (!["read", "update", "delete"].includes(action) ||
      !isValidUser(user) || !isValidRecord(record)) return false;
  if (user.role === "admin") return action !== "delete" || record.archived;
  return action !== "delete" && record.ownerId === user.id;
}
