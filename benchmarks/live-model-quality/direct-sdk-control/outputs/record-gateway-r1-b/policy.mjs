function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

export function isValidUser(user) {
  return isObject(user)
    && hasOwn(user, "id")
    && hasOwn(user, "role")
    && isValidId(user.id)
    && (user.role === "member" || user.role === "admin");
}

function isValidRecord(record) {
  return isObject(record)
    && hasOwn(record, "id")
    && hasOwn(record, "ownerId")
    && hasOwn(record, "title")
    && hasOwn(record, "archived")
    && isValidId(record.id)
    && isValidId(record.ownerId)
    && typeof record.title === "string"
    && typeof record.archived === "boolean";
}

export function canAccess(user, action, record) {
  if (action !== "read" && action !== "update" && action !== "delete") return false;
  if (!isValidUser(user) || !isValidRecord(record)) return false;
  if (action === "delete") return user.role === "admin" && record.archived;
  return user.role === "admin" || record.ownerId === user.id;
}
