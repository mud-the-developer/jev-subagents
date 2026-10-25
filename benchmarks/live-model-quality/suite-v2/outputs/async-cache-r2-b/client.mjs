import { createAsyncCache } from "./cache.mjs";

export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });
  function normalizeId(id) {
    if (typeof id !== "string" || !id.trim()) {
      throw new TypeError("id must be a non-empty string");
    }
    return id.trim();
  }

  return {
    getUser(id) { return cache.get(normalizeId(id)); },
    invalidateUser(id) { cache.invalidate(normalizeId(id)); },
  };
}
