export function createAsyncCache({ load, now, ttlMs }) {
  if (typeof load !== "function" || typeof now !== "function" ||
      typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError("Invalid cache configuration");
  }
  const entries = new Map();
  const validKey = key => {
    if (typeof key !== "string" || key.length === 0) throw new TypeError("Invalid key");
  };
  return {
    get(key) {
      validKey(key);
      const hit = entries.get(key);
      if (hit?.state === "pending") return hit.promise;
      if (hit?.state === "settled" && now() < hit.until) return Promise.resolve(hit.value);
      let source;
      try { source = Promise.resolve(load(key)); }
      catch (error) { return Promise.reject(error); }
      const entry = { state: "pending", promise: null };
      const promise = source.then(value => {
        if (entries.get(key) === entry) {
          entry.state = "settled";
          entry.value = value;
          entry.until = now() + ttlMs;
        }
        return value;
      }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entry.promise = promise;
      entries.set(key, entry);
      return promise;
    },
    invalidate(key) {
      validKey(key);
      entries.delete(key);
    },
  };
}
