export function isValidUser(user) { return !!user && !!user.id; }
export function canAccess(user, action, record) {
  if (!isValidUser(user) || !record) return false;
  return user.role === "admin" || action === "read" || record.ownerId === user.id;
}
