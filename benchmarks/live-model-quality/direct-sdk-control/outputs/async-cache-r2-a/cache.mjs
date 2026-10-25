export function createAsyncCache({ load, now, ttlMs }) {
  if (typeof load !== "function" || typeof now !== "function" ||
      !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError("invalid cache configuration");
  }

  const entries = new Map();

  function validKey(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("invalid key");
    }
  }

  return {
    get(key) {
      validKey(key);
      const existing = entries.get(key);
      if (existing) {
        if (existing.pending) return existing.promise;
        try {
          if (now() < existing.resolvedAt + ttlMs) {
            return Promise.resolve(existing.value);
          }
        } catch (error) {
          return Promise.reject(error);
        }
      }

      const entry = { pending: true };
      entry.promise = Promise.resolve().then(() => load(key)).then(
        value => {
          let resolvedAt;
          try {
            resolvedAt = now();
          } catch (error) {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          }
          if (entries.get(key) === entry) {
            entry.pending = false;
            entry.value = value;
            entry.resolvedAt = resolvedAt;
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
      validKey(key);
      entries.delete(key);
    },
  };
}
