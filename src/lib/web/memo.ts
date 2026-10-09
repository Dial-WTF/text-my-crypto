/**
 * A small per-isolate cache for public, read-only lookups that hit a chain or an outside API (chain page
 * demos). Each key is loaded at most once per `ttlMs`, however many people ask, which is also the rate
 * limit on the upstream call. A failed load is not kept, so the next request tries again.
 */
type Entry<T> = { at: number; value: Promise<T> };

export function memoizer<T>({ ttlMs, maxKeys = 500 }: { ttlMs: number; maxKeys?: number }) {
  const entries = new Map<string, Entry<T>>();
  return function memo(key: string, load: () => Promise<T>, now: number = Date.now()): Promise<T> {
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    if (entries.size >= maxKeys) {
      // Oldest first: Map keeps insertion order.
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    const value = load();
    entries.delete(key);
    entries.set(key, { at: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
