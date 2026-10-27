import { createAsyncCache } from "./cache.mjs";
export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });

  function normalizeId(id) {
    if (typeof id !== "string") throw new TypeError("invalid user id");
    const trimmed = id.trim();
    if (trimmed.length === 0) throw new TypeError("invalid user id");
    return trimmed;
  }

  return {
    getUser(id) {
      return cache.get(normalizeId(id));
    },
    invalidateUser(id) {
      cache.invalidate(normalizeId(id));
    },
  };
}
