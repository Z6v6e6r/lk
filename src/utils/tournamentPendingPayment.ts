import type { TournamentRegistrationState } from "./tournamentSignupApi";

const PREFIX = "padlhub:tournament-payment:";
const VERSION = "v2:";

export function tournamentPaymentSessionIdentity(token: string | null): string | null {
  if (!token) return null;
  try {
    const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(encoded));
    if (typeof claims.sub === "string" && claims.sub && typeof claims.iss === "string" && claims.iss) {
      return JSON.stringify([claims.iss, claims.sub, claims.aud, claims.sid, claims.auth_time]);
    }
  } catch { /* An opaque token cannot prove continuity after refresh. */ }
  return token;
}

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

// A cache partition, never authentication evidence. Only a fresh server booking
// may supply the booking ID. Tokens themselves are never persisted here.
async function key(token: string | null, exerciseId: string, bookingId?: string | null) {
  const identity = tournamentPaymentSessionIdentity(token);
  if (!identity || !exerciseId || !bookingId || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const scope = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${PREFIX}${VERSION}${scope}:${encodeURIComponent(exerciseId)}:${encodeURIComponent(bookingId)}`;
}

export function clearTournamentPendingPayments(exerciseId?: string): void {
  try {
    const target = storage();
    if (!target) return;
    for (let i = target.length - 1; i >= 0; i--) {
      const name = target.key(i);
      if (name?.startsWith(PREFIX) && (!exerciseId || name === `${PREFIX}${exerciseId}`
        || (name.startsWith(`${PREFIX}${VERSION}`) && name.split(":").at(-2) === encodeURIComponent(exerciseId)))) target.removeItem(name);
    }
  } catch { /* Embedded storage may be unavailable. */ }
}

export function canPayTournamentPending(registration: TournamentRegistrationState | null, now = Date.now()): boolean {
  if (registration?.status !== "PAYMENT_PENDING" || !registration.bookingId || typeof registration.paymentUrl !== "string"
    || typeof registration.paymentExpiresAt !== "string" || !registration.paymentExpiresAt || Date.parse(registration.paymentExpiresAt) <= now
    || !Number.isFinite(Date.parse(registration.paymentExpiresAt))) return false;
  try {
    const url = new URL(registration.paymentUrl);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export async function storeTournamentPendingPayment(token: string | null, exerciseId: string, registration: TournamentRegistrationState) {
  if (!canPayTournamentPending(registration)) return;
  try {
    const name = await key(token, exerciseId, registration.bookingId);
    if (name) storage()?.setItem(name, JSON.stringify({ bookingId: registration.bookingId,
      paymentUrl: registration.paymentUrl, paymentExpiresAt: registration.paymentExpiresAt }));
  } catch { /* Never replace a fresh response with unbound cache state. */ }
}

export async function mergeTournamentPendingPayment(token: string | null, exerciseId: string,
  registration: TournamentRegistrationState | null): Promise<TournamentRegistrationState | null> {
  // v1 had no account/booking binding and must never be consumed.
  try { storage()?.removeItem(`${PREFIX}${exerciseId}`); } catch { /* no-op */ }
  if (!registration || registration.status !== "PAYMENT_PENDING") return registration;
  let result = { ...registration };
  try {
    const name = await key(token, exerciseId, registration.bookingId);
    const raw = name ? storage()?.getItem(name) : null;
    const saved = raw ? JSON.parse(raw) : null;
    if (saved?.bookingId === registration.bookingId && canPayTournamentPending({ ...registration, ...saved })
      && (!registration.paymentUrl || registration.paymentUrl === saved.paymentUrl)) {
      result = { ...registration, paymentUrl: registration.paymentUrl || saved.paymentUrl,
        paymentExpiresAt: registration.paymentExpiresAt || saved.paymentExpiresAt };
    }
    if (!canPayTournamentPending(result)) {
      if (name) storage()?.removeItem(name);
      result = { ...result, paymentUrl: null };
    }
  } catch { result = { ...registration, paymentUrl: canPayTournamentPending(registration) ? registration.paymentUrl : null }; }
  return result;
}
