import { createAsyncCache } from "./cache.mjs";
export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });
  const validId = id => {
    if (typeof id !== "string") throw new TypeError("Invalid user ID");
    const trimmed = id.trim();
    if (trimmed.length === 0) throw new TypeError("Invalid user ID");
    return trimmed;
  };
  return {
    getUser(id) { return cache.get(validId(id)); },
    invalidateUser(id) { cache.invalidate(validId(id)); },
  };
}
