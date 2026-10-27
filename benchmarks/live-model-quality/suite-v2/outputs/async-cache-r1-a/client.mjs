import { createAsyncCache } from "./cache.mjs";
export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });
  function keyFor(id) {
    if (typeof id !== "string") throw new TypeError("invalid id");
    const key = id.trim();
    if (key.length === 0) throw new TypeError("invalid id");
    return key;
  }
  return {
    getUser(id) { return cache.get(keyFor(id)); },
    invalidateUser(id) { cache.invalidate(keyFor(id)); },
  };
}
