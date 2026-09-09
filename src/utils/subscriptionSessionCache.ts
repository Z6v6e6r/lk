/** Display snapshots only. Booking/price decisions must always use the server. */
const STORAGE_KEY = "padlhub_subscription_snapshot_v1";
const GLOBAL_KEY = "__padlhubSubscriptionSnapshotV1";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 100;

type Result<T> = { data: T | null; error: { status: number | null; message: string; raw?: unknown } | null; status: number | null };
type Entry = { data: unknown; savedAt: number };
type Snapshot = {
  scope: string;
  generation: number;
  invalidation: number;
  entries: Map<string, Entry>;
  pending: Map<string, Promise<Result<unknown>>>;
};

function storage() {
  try { return typeof window === "undefined" ? null : window.sessionStorage; }
  catch { return null; }
}

function state(): Snapshot {
  const host = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Snapshot };
  if (!host[GLOBAL_KEY]) {
    host[GLOBAL_KEY] = { scope: "", generation: 0, invalidation: 0, entries: new Map(), pending: new Map() };
  }
  return host[GLOBAL_KEY];
}

export function invalidateSubscriptionSnapshot(): void {
  const snapshot = state();
  snapshot.generation += 1;
  snapshot.invalidation += 1;
  snapshot.entries.clear();
  snapshot.pending.clear();
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* Storage can be disabled. */ }
}

/** Hash only for cache partitioning, never as proof of authentication. */
async function accountScope(token: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  let identity = token;
  try {
    const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(encoded));
    if (typeof claims.sub === "string" && typeof claims.iss === "string") {
      identity = JSON.stringify([claims.iss, claims.sub, claims.aud, claims.sid, claims.auth_time]);
      if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
    }
  } catch { /* Opaque tokens use their digest; a refresh starts a new snapshot. */ }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

function restore(snapshot: Snapshot, scope: string) {
  if (snapshot.scope === scope) return;
  snapshot.generation += 1;
  snapshot.scope = scope;
  snapshot.entries.clear();
  snapshot.pending.clear();
  try {
    const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) || "null");
    if (saved?.scope === scope && Array.isArray(saved.entries)) {
      for (const row of saved.entries.slice(-MAX_ENTRIES)) {
        if (!Array.isArray(row) || typeof row[0] !== "string") continue;
        const entry = row[1];
        if (entry && typeof entry.savedAt === "number" && entry.savedAt <= Date.now()
          && Date.now() - entry.savedAt < MAX_AGE_MS) snapshot.entries.set(row[0], entry);
      }
    }
    storage()?.removeItem(STORAGE_KEY);
  } catch { /* Ignore malformed or unavailable session storage. */ }
  persist(snapshot);
}

function persist(snapshot: Snapshot) {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ scope: snapshot.scope, entries: [...snapshot.entries] }));
  } catch { /* The in-memory snapshot still works without browser storage. */ }
}

function clone<T>(data: T): T { return JSON.parse(JSON.stringify(data)) as T; }

export async function readSubscriptionSnapshot<T>(options: {
  key: string;
  token: string | null;
  currentToken: () => string | null;
  load: () => Promise<Result<T>>;
  sanitize: (data: unknown) => T | null;
}): Promise<Result<T>> {
  const snapshot = state();
  const stale = (): Result<T> => ({ data: null, error: { status: 409, message: "Данные абонементов изменились. Обновите список." }, status: 409 });
  if (!options.token) {
    invalidateSubscriptionSnapshot();
    return options.load();
  }
  const invalidationBeforeScope = snapshot.invalidation;
  const scope = await accountScope(options.token);
  if (options.currentToken() !== options.token || snapshot.invalidation !== invalidationBeforeScope) return stale();
  if (!scope) return options.load();
  restore(snapshot, scope);
  const generation = snapshot.generation;
  const current = () => snapshot.generation === generation && snapshot.scope === scope
    && options.currentToken() === options.token;
  const cached = snapshot.entries.get(options.key);
  if (cached && Date.now() - cached.savedAt < MAX_AGE_MS) {
    const data = options.sanitize(cached.data);
    if (data !== null) return { data: clone(data), error: null, status: 200 };
  }
  const pending = snapshot.pending.get(options.key);
  if (pending) {
    const result = await pending;
    return current() ? clone(result) as Result<T> : stale();
  }
  const promise = (async () => {
    const result = await options.load();
    if (!current()) return stale();
    const data = !result.error && result.status === 200 ? options.sanitize(result.data) : null;
    if (data !== null) {
      if (snapshot.entries.size >= MAX_ENTRIES) snapshot.entries.delete(snapshot.entries.keys().next().value!);
      snapshot.entries.set(options.key, { data: clone(data), savedAt: Date.now() });
      persist(snapshot);
    }
    return result;
  })();
  snapshot.pending.set(options.key, promise);
  try { return await promise; }
  finally { if (snapshot.pending.get(options.key) === promise) snapshot.pending.delete(options.key); }
}

/** Invalidate around writes, including ambiguous failures and partial cancellations. */
export function requestChangesSubscriptions(url: string, method = "GET", body?: unknown): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return false;
  let path: string;
  try { path = new URL(url, "https://lk.invalid").pathname; } catch { return false; }
  if (verb === "DELETE" && /\/end-user\/api\/v\d+\/[^/]+\/bookings\/[^/]+$/.test(path)) return true;
  if (verb !== "POST") return false;
  if (path === "/lk/games/split/cleanup") {
    try { if (typeof body === "string" && JSON.parse(body).dryRun === true) return false; }
    catch { return false; }
    return true;
  }
  return path === "/lk/subscription-bookings"
    || /^\/lk\/tournaments\/(?:summer|referral)-subscription\/purchase$/.test(path)
    || /^\/lk\/games\/(?:[^/]+\/)?split\/(?:create|join|leave)$/.test(path)
    || /\/end-user\/api\/v\d+\/[^/]+\/transactions$/.test(path)
    || /\/end-user\/api\/v\d+\/[^/]+\/bookings\/[^/]+\/cancel$/.test(path);
}
