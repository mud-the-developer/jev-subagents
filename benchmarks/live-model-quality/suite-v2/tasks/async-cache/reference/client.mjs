import { createAsyncCache } from "./cache.mjs";
export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });
  const key = id => {
    if (typeof id !== "string" || !id.trim()) throw new TypeError("Invalid user ID");
    return id.trim();
  };
  return {
    getUser(id) { return cache.get(key(id)); },
    invalidateUser(id) { cache.invalidate(key(id)); },
  };
}
