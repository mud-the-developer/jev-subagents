export function createAsyncCache({ load, now, ttlMs }) {
  if (typeof load !== "function" || typeof now !== "function" || !Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError("Invalid cache options");
  const entries = new Map();
  const validateKey = key => { if (typeof key !== "string" || !key.length) throw new TypeError("Invalid cache key"); };
  return {
    get(key) {
      validateKey(key);
      const hit = entries.get(key);
      if (hit && (hit.pending || now() < hit.until)) return hit.promise;
      const entry = { pending: true, until: 0, promise: undefined };
      entry.promise = Promise.resolve().then(() => load(key)).then(value => {
        if (entries.get(key) === entry) { entry.pending = false; entry.until = now() + ttlMs; }
        return value;
      }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    invalidate(key) { validateKey(key); entries.delete(key); },
  };
}
