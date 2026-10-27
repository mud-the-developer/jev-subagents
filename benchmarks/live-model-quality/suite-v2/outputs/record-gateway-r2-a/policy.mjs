const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

export function isValidUser(user) {
  return isObject(user) &&
    Object.prototype.hasOwnProperty.call(user, "id") &&
    Object.prototype.hasOwnProperty.call(user, "role") &&
    validId(user.id) &&
    (user.role === "member" || user.role === "admin");
}

function isValidRecord(record) {
  return isObject(record) &&
    Object.prototype.hasOwnProperty.call(record, "id") &&
    Object.prototype.hasOwnProperty.call(record, "ownerId") &&
    Object.prototype.hasOwnProperty.call(record, "title") &&
    Object.prototype.hasOwnProperty.call(record, "archived") &&
    validId(record.id) && validId(record.ownerId) &&
    typeof record.title === "string" && typeof record.archived === "boolean";
}

export function canAccess(user, action, record) {
  if (!isValidUser(user) || !isValidRecord(record) ||
      (action !== "read" && action !== "update" && action !== "delete")) return false;
  if (user.role === "admin") return action !== "delete" || record.archived === true;
  return action !== "delete" && record.ownerId === user.id;
}
