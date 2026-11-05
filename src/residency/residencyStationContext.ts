export const RESIDENCY_STATION_STORAGE_KEY = "padlhub.residency.station.v1";
export const RESIDENCY_ENTRY_QUERY_KEYS = ["residency", "resident", "residentPass"] as const;
const STATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export interface ResidencyEntryContext {
  requested: boolean;
  stationId: string | null;
}

export function normalizeResidencyStationId(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return STATION_ID_PATTERN.test(text) ? text : null;
}

function readTruthyFlag(value: string | null): boolean {
  const text = (value ?? "").trim().toLowerCase();
  return text === "" || text === "1" || text === "true" || text === "yes" || text === "on";
}

/** Reads the station entry context from a query string (LK is loaded from a station QR). */
export function readResidencyEntryFromSearch(search: string): ResidencyEntryContext {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { requested: false, stationId: null };
  }
  const requested = RESIDENCY_ENTRY_QUERY_KEYS.some((key) => params.has(key) && readTruthyFlag(params.get(key)));
  if (!requested) return { requested: false, stationId: null };
  return { requested: true, stationId: normalizeResidencyStationId(params.get("stationId")) };
}

function readStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Persists the station context across the login flow. Only a station id is stored: no tokens,
 * no subscription ids and no personal data.
 */
export function persistResidencyEntryContext(context: ResidencyEntryContext): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(RESIDENCY_STATION_STORAGE_KEY, JSON.stringify({
      requested: context.requested === true,
      stationId: normalizeResidencyStationId(context.stationId),
    }));
  } catch {
    // Storage may be unavailable (private mode); the URL itself still carries the context.
  }
}

export function readPersistedResidencyEntryContext(): ResidencyEntryContext {
  const storage = readStorage();
  if (!storage) return { requested: false, stationId: null };
  try {
    const raw = storage.getItem(RESIDENCY_STATION_STORAGE_KEY);
    if (!raw) return { requested: false, stationId: null };
    const parsed = JSON.parse(raw) as { requested?: unknown; stationId?: unknown };
    return {
      requested: parsed?.requested === true,
      stationId: normalizeResidencyStationId(parsed?.stationId),
    };
  } catch {
    return { requested: false, stationId: null };
  }
}

export function clearPersistedResidencyEntryContext(): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.removeItem(RESIDENCY_STATION_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Resolves the residency entry for the current page load: the query string wins, the stored
 * context survives the login view. The stored flag is consumed once so later cabinet loads
 * do not reopen the screen.
 */
export function consumeResidencyEntryContext(search: string): { entry: ResidencyEntryContext; consumed: boolean } {
  const fromUrl = readResidencyEntryFromSearch(search);
  if (fromUrl.requested) {
    persistResidencyEntryContext(fromUrl);
    return { entry: fromUrl, consumed: true };
  }
  const stored = readPersistedResidencyEntryContext();
  if (stored.requested) {
    return { entry: stored, consumed: true };
  }
  return { entry: { requested: false, stationId: null }, consumed: false };
}
