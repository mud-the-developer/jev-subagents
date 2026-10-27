import { createAsyncCache } from "./cache.mjs";

export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });

  function normalizeId(id) {
    if (typeof id === "string") {
      const key = id.trim();
      if (key.length > 0) return key;
    }
    throw new TypeError("ID must be a string with non-empty trimmed content");
  }

  return {
    getUser(id) { return cache.get(normalizeId(id)); },
    invalidateUser(id) { cache.invalidate(normalizeId(id)); },
  };
}
