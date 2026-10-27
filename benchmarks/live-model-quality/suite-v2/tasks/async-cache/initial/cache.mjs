export function createAsyncCache({ load, now, ttlMs }) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit && hit.until > now()) return Promise.resolve(hit.value);
      const value = load(key);
      entries.set(key, { value, until: now() + ttlMs });
      return Promise.resolve(value);
    },
    invalidate(key) { entries.delete(key); },
  };
}
