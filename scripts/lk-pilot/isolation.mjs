const ACCESS_TOKEN_KEY = "padlhub_auth_token_v1";

export function pilotLocalStorage(cabinetStorage) {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key(index) { return [...entries.keys()][index] ?? null; },
    getItem(key) {
      return key === ACCESS_TOKEN_KEY ? cabinetStorage.getItem(key) : entries.get(key) ?? null;
    },
    setItem(key, value) {
      if (key !== ACCESS_TOKEN_KEY) entries.set(key, String(value));
    },
    removeItem(key) { entries.delete(key); },
    clear() { entries.clear(); },
  };
}

export function normalizedPilotQuery(search) {
  const allowed = new Set(["screen", "eventId", "date", "studioId"]);
  const safe = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (allowed.has(key) && !safe.has(key)) safe.set(key, value);
  }
  return safe.toString();
}
