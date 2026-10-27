const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const idPattern = /^[a-z][a-z0-9_-]{0,31}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidId(value) {
  return typeof value === "string" && idPattern.test(value);
}

export function isValidUser(user) {
  return isObject(user) && hasOwn(user, "id") && hasOwn(user, "role") &&
    isValidId(user.id) && (user.role === "member" || user.role === "admin");
}

function isValidRecord(record) {
  return isObject(record) && hasOwn(record, "id") && hasOwn(record, "ownerId") &&
    hasOwn(record, "title") && hasOwn(record, "archived") &&
    isValidId(record.id) && isValidId(record.ownerId) &&
    typeof record.title === "string" && typeof record.archived === "boolean";
}

export function canAccess(user, action, record) {
  if (!isValidUser(user) || !isValidRecord(record) ||
      (action !== "read" && action !== "update" && action !== "delete")) return false;
  if (user.role === "admin") return action !== "delete" || record.archived;
  return action !== "delete" && record.ownerId === user.id;
}
