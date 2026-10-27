const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

function isValidRecord(record) {
  return isObject(record) &&
    hasOwn(record, "id") && hasOwn(record, "ownerId") &&
    hasOwn(record, "title") && hasOwn(record, "archived") &&
    isValidId(record.id) && isValidId(record.ownerId) &&
    typeof record.title === "string" && typeof record.archived === "boolean";
}

export function isValidUser(user) {
  return isObject(user) && hasOwn(user, "id") && hasOwn(user, "role") &&
    isValidId(user.id) && (user.role === "member" || user.role === "admin");
}

export function canAccess(user, action, record) {
  if (!isValidUser(user) || !isValidRecord(record)) return false;
  if (action !== "read" && action !== "update" && action !== "delete") return false;
  if (user.role === "member") return action !== "delete" && record.ownerId === user.id;
  return action !== "delete" || record.archived === true;
}
