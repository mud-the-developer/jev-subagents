export function createAsyncCache({ load, now, ttlMs }) {
  if (typeof load !== "function" || typeof now !== "function" ||
      !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError("load and now must be functions; ttlMs must be finite and non-negative");
  }

  const entries = new Map();
  function validateKey(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("key must be a non-empty string");
    }
  }

  return {
    get(key) {
      validateKey(key);
      const hit = entries.get(key);
      if (hit && (hit.pending || (ttlMs > 0 && now() < hit.until))) {
        return hit.promise;
      }

      let resolveLoad;
      let rejectLoad;
      const entry = { pending: true };
      entry.promise = new Promise((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
      }).then(
        value => {
          if (entries.get(key) === entry) {
            entry.until = now() + ttlMs;
            entry.pending = false;
          }
          return value;
        },
        error => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      // Admit the pending load before invoking user code, including reentrant gets.
      entries.set(key, entry);
      try {
        resolveLoad(load(key));
      } catch (error) {
        rejectLoad(error);
      }
      return entry.promise;
    },
    invalidate(key) {
      validateKey(key);
      entries.delete(key);
    },
  };
}
