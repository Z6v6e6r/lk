import type { Subscription } from "../utils/apiClient";

export const RESIDENT_PASS_TOKEN_PATTERN = /^rsp1_[A-Za-z0-9_-]{16,}$/;
export const RESIDENT_PASS_ID_PATTERN =
  /^resident_pass:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum automatic regenerations while the CUP status route is unavailable. */
export const MAX_AUTO_RENEWALS_WITHOUT_STATUS = 3;
/** Automatic regenerations allowed with a working status route (until CONSUMED). */
export const MAX_AUTO_RENEWALS_WITH_STATUS = 20;
export const MAX_PROBED_CANDIDATES = 3;

export interface ResidencyTerm {
  subscriptionTypeId: string;
  subscriptionTypeTitle: string | null;
  activeFrom: string;
  activeTo: string;
}

export interface ResidentPass {
  schemaVersion: 1;
  passId: string;
  passToken: string;
  issuedAt: string;
  expiresAt: string;
  subscriptionInstanceId: string;
  residency: ResidencyTerm;
}

export type ResidencyPassStatus = "ACTIVE" | "CONSUMED" | "EXPIRED" | "UNKNOWN";

export interface ResidentPassStatus {
  schemaVersion: 1;
  statusAvailable: boolean;
  state: ResidencyPassStatus;
  issuedAt: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
}

export interface ResidencyCandidate {
  clientSubscriptionId: string;
  name: string;
  expirationDate: string | null;
  holdUntil: string | null;
}

export type ResidencyViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "selecting"; candidates: ResidencyCandidate[] }
  | { kind: "active"; pass: ResidentPass; renewals: number }
  | { kind: "issued"; pass: ResidentPass; consumedAt: string | null }
  | { kind: "expired"; pass: ResidentPass | null; autoRenewEnabled: boolean }
  | { kind: "no_subscription" }
  | { kind: "not_resident" }
  | { kind: "frozen"; holdUntil: string | null }
  | { kind: "term_expired" }
  | { kind: "offline"; pass: ResidentPass | null }
  | { kind: "unavailable"; code: string; retryable: boolean }
  | { kind: "session_expired" }
  | { kind: "rate_limited" }
  | { kind: "error"; code: string; retryable: boolean };

export type ResidencyFailureCode = string;

export interface ResidencyFailure {
  code: ResidencyFailureCode;
  status: number | null;
  networkError: boolean;
}

export interface ActiveCandidatesResult {
  candidates: ResidencyCandidate[];
  frozen: { holdUntil: string | null; name: string } | null;
  unavailable: boolean;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function parseDateMs(value: unknown): number | null {
  const text = toText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const RESIDENT_NAME_PATTERN = /(резидент|resident)/i;
const INACTIVE_STATUS_MARKERS = ["CANCEL", "CLOSE", "FINISH", "EXPIRED", "ARCHIVE", "VOID", "DELETED", "FROZEN", "HOLD"];

/**
 * Resolves the resident-pass candidates from LK's own subscription list.
 *
 * This ordering is a non-authoritative hint only: CUP remains the authority on residency.
 * Frozen or expired subscriptions are not probed; a future holdUntil is reported separately
 * so the screen can show "frozen" without calling the gateway.
 */
export function resolveActiveCandidates(
  subscriptions: readonly Subscription[] | null | undefined,
  nowMs: number,
): ActiveCandidatesResult {
  const result: ActiveCandidatesResult = { candidates: [], frozen: null, unavailable: false };
  if (!subscriptions) {
    result.unavailable = true;
    return result;
  }
  const active: ResidencyCandidate[] = [];
  let frozen: { holdUntil: string | null; name: string; holdMs: number } | null = null;

  for (const subscription of subscriptions) {
    const clientSubscriptionId = toText(subscription?.subscriptionId);
    if (!clientSubscriptionId) continue;
    const name = toText(subscription?.name) || "Абонемент";
    const status = (toText(subscription?.status) || "").toUpperCase();
    const activationMs = parseDateMs(subscription?.activationDate);
    const expirationMs = parseDateMs(subscription?.expirationDate);
    const holdMs = parseDateMs(subscription?.holdUntil);

    if (holdMs !== null && holdMs > nowMs) {
      if (!frozen || holdMs > frozen.holdMs) {
        frozen = { holdUntil: subscription?.holdUntil ?? null, name, holdMs };
      }
      continue;
    }
    if (status && INACTIVE_STATUS_MARKERS.some((marker) => status.includes(marker))) continue;
    if (activationMs !== null && activationMs > nowMs) continue;
    if (expirationMs !== null && expirationMs <= nowMs) continue;

    active.push({
      clientSubscriptionId,
      name,
      expirationDate: subscription?.expirationDate ?? null,
      holdUntil: subscription?.holdUntil ?? null,
    });
  }

  active.sort((left, right) => {
    const leftResident = RESIDENT_NAME_PATTERN.test(left.name) ? 1 : 0;
    const rightResident = RESIDENT_NAME_PATTERN.test(right.name) ? 1 : 0;
    if (leftResident !== rightResident) return rightResident - leftResident;
    const leftExpiration = parseDateMs(left.expirationDate);
    const rightExpiration = parseDateMs(right.expirationDate);
    if (leftExpiration === null && rightExpiration === null) return 0;
    if (leftExpiration === null) return 1;
    if (rightExpiration === null) return -1;
    return rightExpiration - leftExpiration;
  });

  result.candidates = active.slice(0, MAX_PROBED_CANDIDATES);
  if (frozen) {
    result.frozen = { holdUntil: frozen.holdUntil, name: frozen.name };
  }
  return result;
}

/** Candidates left to probe after the given failure, or an empty list when the state is final. */
export function isProbeableFailure(code: ResidencyFailureCode): boolean {
  return (
    code === "RESIDENT_CLIENT_SUBSCRIPTION_INVALID"
    || code === "RESIDENT_PASS_NOT_FOUND"
    || code === "RESIDENT_NOT_ACTIVE"
    || code === "RESIDENT_TERM_EXPIRED"
  );
}

export function mapFailureToState(failure: ResidencyFailure): ResidencyViewState {
  const code = failure.code;
  if (failure.networkError) return { kind: "offline", pass: null };
  if (code === "RESIDENT_CLIENT_AUTH_REQUIRED" || failure.status === 401) return { kind: "session_expired" };
  if (code === "RESIDENT_CLIENT_RATE_LIMITED" || failure.status === 429) return { kind: "rate_limited" };
  if (code === "RESIDENT_CLIENT_SUBSCRIPTION_FROZEN") return { kind: "frozen", holdUntil: null };
  if (code === "RESIDENT_TERM_EXPIRED") return { kind: "term_expired" };
  if (code === "RESIDENT_CLIENT_SUBSCRIPTION_INVALID" || code === "RESIDENT_PASS_NOT_FOUND" || code === "RESIDENT_NOT_ACTIVE") {
    return { kind: "not_resident" };
  }
  if (
    code === "RESIDENT_EVIDENCE_STALE"
    || code === "RESIDENT_EVIDENCE_INVALID"
    || code === "RESIDENT_MAPPING_NOT_CURRENT"
    || code === "RESIDENT_MAPPING_STALE"
    || code === "RESIDENT_POLICY_NOT_CURRENT"
    || code === "RESIDENT_TYPE_NOT_FOUND"
    || code === "RESIDENT_INSTANCE_NOT_FOUND"
    || code === "RESIDENT_SERVICES_PERSISTENCE_UNAVAILABLE"
    || code === "RESIDENT_SERVICES_DISABLED"
    || code === "RESIDENT_SERVICES_NOT_CONFIGURED"
    || code === "RESIDENT_SERVICES_CONFIG_INVALID"
    || code === "RESIDENT_CLIENT_NOT_CONFIGURED"
    || code === "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE"
    || code === "RESIDENT_CLIENT_UPSTREAM_INVALID"
    || code === "RESIDENT_CLIENT_UPSTREAM_TIMEOUT"
    || code === "RESIDENT_CLIENT_AUTH_UNAVAILABLE"
    || (failure.status !== null && failure.status >= 500)
  ) {
    return { kind: "unavailable", code, retryable: true };
  }
  if (code === "RESIDENT_CLIENT_FORBIDDEN" || failure.status === 403) {
    return { kind: "error", code, retryable: false };
  }
  return { kind: "error", code, retryable: true };
}

/** Clock skew of the device relative to the server, derived from the pass issuedAt stamp. */
export function computeServerOffsetMs(issuedAt: string, receivedAtMs: number): number {
  const issuedMs = parseDateMs(issuedAt);
  if (issuedMs === null) return 0;
  return issuedMs - receivedAtMs;
}

export function passRemainingMs(pass: ResidentPass, serverOffsetMs: number, nowMs: number): number {
  const expiresMs = parseDateMs(pass.expiresAt);
  if (expiresMs === null) return 0;
  return expiresMs - (nowMs + serverOffsetMs);
}

export function isPassUsable(pass: ResidentPass, serverOffsetMs: number, nowMs: number): boolean {
  return passRemainingMs(pass, serverOffsetMs, nowMs) > 0;
}

export function formatCountdown(remainingMs: number): string {
  const clamped = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface RenewalPolicyInput {
  visible: boolean;
  online: boolean;
  statusAvailable: boolean;
  renewals: number;
  stopped: boolean;
}

/**
 * Auto-regeneration is allowed while the screen is visible and the user is online, and is
 * bounded: with a working status route it can refresh until the pass is confirmed CONSUMED;
 * without one the screen cannot distinguish "issued" from "expired", so it stops early and
 * asks for an explicit action.
 */
export function shouldAutoRenew(input: RenewalPolicyInput): boolean {
  if (input.stopped) return false;
  if (!input.visible) return false;
  if (!input.online) return false;
  return input.renewals < (input.statusAvailable ? MAX_AUTO_RENEWALS_WITH_STATUS : MAX_AUTO_RENEWALS_WITHOUT_STATUS);
}

/**
 * Builds the QR value for the CUP staff check screen.
 *
 * The pass token lives in the URL fragment: fragments are not sent to the server, are absent
 * from HTTP access logs and never become a Referer path.
 */
export function buildResidentPassQrValue(
  checkUrl: string,
  passToken: string,
  stationId: string | null,
): string | null {
  const token = toText(passToken);
  if (!token || !RESIDENT_PASS_TOKEN_PATTERN.test(token)) return null;
  const base = (toText(checkUrl) || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(base)) return null;
  const params = [`pass=${encodeURIComponent(token)}`];
  const station = toText(stationId);
  if (station) params.push(`stationId=${encodeURIComponent(station)}`);
  const value = `${base}#${params.join("&")}`;
  return value.length <= 2048 ? value : null;
}

export function isResidentPassStatusPayload(value: unknown): value is ResidentPassStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const state = toText(record.state);
  return record.schemaVersion === 1
    && typeof record.statusAvailable === "boolean"
    && (state === "ACTIVE" || state === "CONSUMED" || state === "EXPIRED" || state === "UNKNOWN");
}

export function isResidentPassPayload(value: unknown): value is ResidentPass {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const residency = record.residency;
  if (!residency || typeof residency !== "object" || Array.isArray(residency)) return false;
  const term = residency as Record<string, unknown>;
  const passId = toText(record.passId);
  const passToken = toText(record.passToken);
  const issuedMs = parseDateMs(record.issuedAt);
  const expiresMs = parseDateMs(record.expiresAt);
  return record.schemaVersion === 1
    && passId !== null
    && RESIDENT_PASS_ID_PATTERN.test(passId)
    && passToken !== null
    && RESIDENT_PASS_TOKEN_PATTERN.test(passToken)
    && toText(record.subscriptionInstanceId) !== null
    && issuedMs !== null
    && expiresMs !== null
    && expiresMs > issuedMs
    && toText(term.subscriptionTypeId) !== null
    && parseDateMs(term.activeFrom) !== null
    && parseDateMs(term.activeTo) !== null;
}

export function formatResidencyTerm(term: ResidencyTerm | null | undefined): string | null {
  if (!term) return null;
  const activeTo = parseDateMs(term.activeTo);
  if (activeTo === null) return null;
  return new Date(activeTo).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
}

export function formatIssueTime(value: string | null | undefined): string | null {
  const parsed = parseDateMs(value);
  if (parsed === null) return null;
  return new Date(parsed).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
