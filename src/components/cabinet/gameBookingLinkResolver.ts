export type UniqueGameLookup<T extends { id: string }> = Map<string, T | null>;

export interface UniqueGameLookupResult<T> {
  matched: boolean;
  value: T | null;
}

export function buildUniqueGameLookup<T extends { id: string }>(
  items: T[],
  collectKeys: (item: T) => Array<string | null | undefined>,
): UniqueGameLookup<T> {
  const lookup: UniqueGameLookup<T> = new Map();
  items.forEach((item) => {
    const keys = Array.from(new Set(
      collectKeys(item)
        .map((key) => String(key || "").trim())
        .filter(Boolean),
    ));
    keys.forEach((key) => {
      if (!lookup.has(key)) {
        lookup.set(key, item);
        return;
      }
      const existing = lookup.get(key);
      if (existing?.id !== item.id) lookup.set(key, null);
    });
  });
  return lookup;
}

export function resolveUniqueGameForKeys<T extends { id: string }>(
  lookup: UniqueGameLookup<T>,
  keys: Array<string | null | undefined>,
): UniqueGameLookupResult<T> {
  let matched = false;
  let resolved: T | null = null;
  for (const rawKey of Array.from(new Set(keys))) {
    const key = String(rawKey || "").trim();
    if (!key || !lookup.has(key)) continue;
    matched = true;
    const candidate = lookup.get(key) ?? null;
    if (!candidate) return { matched: true, value: null };
    if (resolved && resolved.id !== candidate.id) return { matched: true, value: null };
    resolved = candidate;
  }
  return { matched, value: resolved };
}
