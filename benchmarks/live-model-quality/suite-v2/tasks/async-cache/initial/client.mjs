import { createAsyncCache } from "./cache.mjs";
export function createUserClient({ fetchUser, now, ttlMs }) {
  const cache = createAsyncCache({ load: fetchUser, now, ttlMs });
  return {
    getUser(id) { return cache.get(String(id)); },
    invalidateUser(id) { cache.invalidate(String(id)); },
  };
}
