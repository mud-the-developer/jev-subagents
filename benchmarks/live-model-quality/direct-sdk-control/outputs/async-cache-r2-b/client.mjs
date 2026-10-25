import { createAsyncCache } from "./cache.mjs";

export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });
  function normalizeId(id) {
    const key = typeof id === "string" ? id.trim() : "";
    if (!key) throw new TypeError("User IDs must have non-empty trimmed content");
    return key;
  }

  return {
    getUser(id) { return cache.get(normalizeId(id)); },
    invalidateUser(id) { cache.invalidate(normalizeId(id)); },
  };
}
