/**
 * Local operation snapshot for the pilot purchase.
 *
 * It stores only the idempotency keys, the confirmed total and the returned order id so a
 * reload, a second tab or a bank return can repeat/read the *same* operation. It is not a
 * price, a tariff or an authorization proof; the server revalidates every amount and the
 * personal access list.
 */
const STORAGE_KEY = "padlhub_residency_lifecycle_attempt_v1";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ResidencyLifecycleAttempt {
  idempotencyKey: string;
  mode: "NEW" | "RENEWAL";
  expectedTotalMinor: number;
  orderId: string | null;
  reconcileKey: string | null;
  startedAt: number;
}

function storage(): Storage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

function valid(value: unknown): ResidencyLifecycleAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.idempotencyKey !== "string" || row.idempotencyKey.length < 16 || row.idempotencyKey.length > 128) return null;
  if (row.mode !== "NEW" && row.mode !== "RENEWAL") return null;
  if (!Number.isSafeInteger(row.expectedTotalMinor) || (row.expectedTotalMinor as number) <= 0) return null;
  if (row.orderId !== null && (typeof row.orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(row.orderId))) return null;
  if (row.reconcileKey !== null && (typeof row.reconcileKey !== "string" || row.reconcileKey.length < 16)) return null;
  if (!Number.isSafeInteger(row.startedAt) || (row.startedAt as number) <= 0) return null;
  return {
    idempotencyKey: row.idempotencyKey,
    mode: row.mode as ResidencyLifecycleAttempt["mode"],
    expectedTotalMinor: row.expectedTotalMinor as number,
    orderId: row.orderId as string | null,
    reconcileKey: row.reconcileKey as string | null,
    startedAt: row.startedAt as number,
  };
}

export function readResidencyLifecycleAttempt(now = Date.now()): ResidencyLifecycleAttempt | null {
  const store = storage();
  if (!store) return null;
  try {
    const parsed = valid(JSON.parse(store.getItem(STORAGE_KEY) || "null"));
    if (!parsed) { store.removeItem(STORAGE_KEY); return null; }
    if (now - parsed.startedAt > TTL_MS || now - parsed.startedAt < 0) { store.removeItem(STORAGE_KEY); return null; }
    return parsed;
  } catch { return null; }
}

export function saveResidencyLifecycleAttempt(attempt: ResidencyLifecycleAttempt): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(attempt)); } catch { /* The server unresolved lookup is the fallback. */ }
}

export function clearResidencyLifecycleAttempt(): void {
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* nothing to clear */ }
}

export function newResidencyLifecycleKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // A non-crypto fallback is only a retry identity, never a security token.
  return "residency-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}

/** Reuse the same key only for the same confirmed operation. */
export function attemptKeyFor(mode: "NEW" | "RENEWAL", expectedTotalMinor: number, now = Date.now()): string {
  const existing = readResidencyLifecycleAttempt(now);
  if (existing && existing.mode === mode && existing.expectedTotalMinor === expectedTotalMinor) return existing.idempotencyKey;
  return newResidencyLifecycleKey();
}
