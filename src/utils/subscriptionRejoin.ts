// This hint only selects the next explicit submission. The server must verify
// the exact released predecessor before permitting any new booking.
const BASE = /^(lk-split-join-[a-z0-9]+)(?::rejoin:([1-9]\d{0,3}))?$/;
export function subscriptionRejoinIdentity(operationId: string) {
  const match = BASE.exec(operationId);
  if (!match) return null;
  const generation = Number(match[2] || 0);
  if (generation > 1000) return null;
  return { base: match[1], generation };
}

export function nextSubscriptionRejoinId(operationId: string): string | null {
  const identity = subscriptionRejoinIdentity(operationId);
  return identity && identity.generation < 1000
    ? `${identity.base}:rejoin:${identity.generation + 1}` : null;
}

export class SubscriptionRejoinTracker {
  private readonly hints = new Map<string, string>();
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  constructor(storage: Pick<Storage, "getItem" | "setItem"> | null) { this.storage = storage; }

  resolve(base: string): string {
    const candidates = [this.hints.get(base)];
    try { candidates.push(this.storage?.getItem(`lk:subscription-rejoin:${base}`) || undefined); } catch { /* memory fallback */ }
    return candidates.reduce<string>((current, value) => {
      const identity = value ? subscriptionRejoinIdentity(value) : null;
      return identity?.base === base && identity.generation > (subscriptionRejoinIdentity(current)?.generation || 0)
        ? value! : current;
    }, base);
  }

  rememberReleased(operationId: string, status: number | null, raw: unknown): boolean {
    if (status !== 409 || !raw || typeof raw !== "object") return false;
    const details = (raw as { details?: unknown }).details;
    if (!details || typeof details !== "object") return false;
    const value = details as Record<string, unknown>;
    const next = nextSubscriptionRejoinId(operationId);
    if (value.code !== "SUBSCRIPTION_BOOKING_RELEASED" || value.operationId !== operationId
      || !next || value.nextOperationId !== next) return false;
    const base = subscriptionRejoinIdentity(operationId)!.base;
    const current = this.resolve(base);
    if ((subscriptionRejoinIdentity(current)?.generation || 0) > subscriptionRejoinIdentity(next)!.generation) return true;
    this.hints.set(base, next);
    try { this.storage?.setItem(`lk:subscription-rejoin:${base}`, next); } catch { /* memory fallback */ }
    return true;
  }
}
