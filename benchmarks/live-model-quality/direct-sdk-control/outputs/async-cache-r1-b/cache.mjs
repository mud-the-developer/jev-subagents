export function createAsyncCache({ load, now, ttlMs }) {
  if (typeof load !== "function" || typeof now !== "function" ||
      !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError("Invalid cache configuration");
  }

  const entries = new Map();

  function validateKey(key) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("Key must be a non-empty string");
    }
  }

  return {
    get(key) {
      validateKey(key);
      const hit = entries.get(key);
      if (hit && (hit.pending || (ttlMs > 0 && now() < hit.until))) {
        return hit.promise;
      }

      const entry = { pending: true };
      let resolveLoad;
      let rejectLoad;
      const loaded = new Promise((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
      });
      entry.promise = loaded.then(
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
