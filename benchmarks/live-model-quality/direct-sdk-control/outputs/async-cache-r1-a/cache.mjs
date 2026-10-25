export function createAsyncCache({ load, now, ttlMs }) {
  if (typeof load !== "function" || typeof now !== "function" ||
      typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError("Invalid cache configuration");
  }

  const entries = new Map();
  return {
    get(key) {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("Invalid key");
      }
      const existing = entries.get(key);
      if (existing) {
        if (existing.pending) return existing.promise;
        if (ttlMs > 0 && now() < existing.resolvedAt + ttlMs) {
          return Promise.resolve(existing.value);
        }
        entries.delete(key);
      }

      const entry = { pending: true };
      entries.set(key, entry);
      let loaded;
      try {
        loaded = load(key);
      } catch (error) {
        const promise = Promise.reject(error);
        entry.promise = promise;
        promise.then(undefined, () => {
          if (entries.get(key) === entry) entries.delete(key);
        });
        return promise;
      }
      const promise = Promise.resolve(loaded);
      entry.promise = promise;
      promise.then(value => {
        if (entries.get(key) === entry) {
          entry.pending = false;
          entry.value = value;
          entry.resolvedAt = now();
        }
        return value;
      }, () => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return promise;
    },
    invalidate(key) {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("Invalid key");
      }
      entries.delete(key);
    },
  };
}
