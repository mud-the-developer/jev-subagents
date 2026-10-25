const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isValidId = id => typeof id === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(id);

export function isValidUser(user) {
  return isObject(user)
    && hasOwn(user, "id")
    && hasOwn(user, "role")
    && isValidId(user.id)
    && (user.role === "member" || user.role === "admin");
}

function isValidRecord(record) {
  return isObject(record)
    && ["id", "ownerId", "title", "archived"].every(key => hasOwn(record, key))
    && isValidId(record.id)
    && isValidId(record.ownerId)
    && typeof record.title === "string"
    && typeof record.archived === "boolean";
}

export function canAccess(user, action, record) {
  if (!isValidUser(user) || !isValidRecord(record)) return false;
  if (action === "delete") return user.role === "admin" && record.archived;
  if (action === "read" || action === "update") {
    return user.role === "admin" || record.ownerId === user.id;
  }
  return false;
}
