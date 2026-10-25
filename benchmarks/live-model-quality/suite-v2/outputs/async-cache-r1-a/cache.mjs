export function createAsyncCache({ load, now, ttlMs }) {
  if (typeof load !== "function" || typeof now !== "function" ||
      !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError("invalid cache configuration");
  }
  const entries = new Map();
  return {
    get(key) {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("invalid key");
      }
      const existing = entries.get(key);
      if (existing?.state === "pending") return existing.promise;
      if (existing && now() < existing.resolvedAt + ttlMs) {
        return Promise.resolve(existing.value);
      }
      const entry = { state: "pending" };
      let result;
      try {
        result = load(key);
      } catch (error) {
        result = Promise.reject(error);
      }
      entry.promise = Promise.resolve(result).then(
        value => {
          if (entries.get(key) === entry) {
            entry.state = "settled";
            entry.value = value;
            entry.resolvedAt = now();
          }
          return value;
        },
        error => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      entries.set(key, entry);
      return entry.promise;
    },
    invalidate(key) {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("invalid key");
      }
      entries.delete(key);
    },
  };
}
