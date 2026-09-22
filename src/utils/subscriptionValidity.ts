const SUBSCRIPTION_VALIDITY_DATE_KEYS = [
  "expirationDate",
  "activeTo",
  "activeUntil",
  "validTo",
  "validityDate",
  "dateTo",
  "dateEnd",
  "expiresAt",
  "endDate",
  "finishDate",
  "availableUntil",
  "validUntil",
];

const SUBSCRIPTION_VALIDITY_NESTED_KEYS = [
  "subscription",
  "clientSubscription",
  "clientSub",
  "subscriptionProduct",
  "clientSubscriptionProduct",
  "product",
  "raw",
];

const SUBSCRIPTION_VISITS_LEFT_KEYS = [
  "visitsLeft",
  "availableVisits",
  "remainingVisits",
  "visitsRemaining",
  "left",
  "balance",
];

export type SubscriptionUsageDisplayKind = "validity" | "visits";
export type SubscriptionStatusTone = "green" | "gold";

export interface SubscriptionUsageDisplay {
  kind: SubscriptionUsageDisplayKind;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function pickNumber(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw.replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeSubscriptionName(value: string | null | undefined) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatLessonsNoun(value: number) {
  const safeValue = Math.abs(Math.floor(value));
  const lastTwo = safeValue % 100;
  const last = safeValue % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "занятий";
  if (last === 1) return "занятие";
  if (last >= 2 && last <= 4) return "занятия";
  return "занятий";
}

export function pickSubscriptionValidityDate(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = pickString(value, SUBSCRIPTION_VALIDITY_DATE_KEYS);
  if (direct) return direct;
  for (const key of SUBSCRIPTION_VALIDITY_NESTED_KEYS) {
    const nested = value[key];
    if (!isRecord(nested)) continue;
    const nestedDate = pickString(nested, SUBSCRIPTION_VALIDITY_DATE_KEYS);
    if (nestedDate) return nestedDate;
  }
  return null;
}

export function pickSubscriptionVisitsLeft(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const direct = pickNumber(value, SUBSCRIPTION_VISITS_LEFT_KEYS);
  if (direct != null) return direct;
  for (const key of SUBSCRIPTION_VALIDITY_NESTED_KEYS) {
    const nested = value[key];
    if (!isRecord(nested)) continue;
    const nestedVisits = pickNumber(nested, SUBSCRIPTION_VISITS_LEFT_KEYS);
    if (nestedVisits != null) return nestedVisits;
  }
  return null;
}

export function isEnergyVisitPackSubscriptionName(value: string | null | undefined) {
  return /^энергия\s+(5|25)$/.test(normalizeSubscriptionName(value));
}

export function resolveSubscriptionStatusTone(
  value: string | null | undefined,
): SubscriptionStatusTone | null {
  if (isEnergyVisitPackSubscriptionName(value)) return "green";

  const normalized = normalizeSubscriptionName(value);
  const tokens = normalized.split(" ").filter(Boolean);
  const hasSummerPrefix = normalized.includes("лето падел");
  const isShortSummerName = tokens.length === 1 && [
    "академия",
    "дружба",
    "ра",
    "спорт",
  ].includes(tokens[0]);

  if (!hasSummerPrefix && !isShortSummerName) return null;

  if (tokens.some((token) => token.startsWith("спорт") || token.startsWith("друж"))) {
    return "green";
  }
  if (tokens.some((token) => token === "ра" || token.startsWith("академ"))) {
    return "gold";
  }
  return null;
}

export function formatSubscriptionVisitsLeftLabel(
  value: number | null | undefined,
  prefix = "",
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const safeValue = Math.max(0, Math.floor(value));
  const label = `${safeValue} ${formatLessonsNoun(safeValue)}`;
  return prefix ? `${prefix} ${label}` : label;
}

export function formatSubscriptionValidityDate(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)?.[0] || null;
  const parsed = dateOnly ? new Date(`${dateOnly}T00:00:00`) : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatSubscriptionValidityLabel(
  value: string | null | undefined,
  prefix = "до",
): string | null {
  const formatted = formatSubscriptionValidityDate(value);
  return formatted ? `${prefix} ${formatted}` : null;
}

export function resolveSubscriptionUsageDisplay(params: {
  subscriptionName: string | null | undefined;
  validityDate?: string | null | undefined;
  visitsLeft?: number | null | undefined;
  raw?: unknown;
  validityPrefix?: string;
  visitsPrefix?: string;
  fallback?: string;
}): SubscriptionUsageDisplay | null {
  const visitsLeft = params.visitsLeft ?? pickSubscriptionVisitsLeft(params.raw);
  if (isEnergyVisitPackSubscriptionName(params.subscriptionName)) {
    const visitsLabel = formatSubscriptionVisitsLeftLabel(visitsLeft, params.visitsPrefix || "");
    if (visitsLabel) return { kind: "visits", label: visitsLabel };
  }

  const validityDate = params.validityDate ?? pickSubscriptionValidityDate(params.raw);
  const validityLabel = formatSubscriptionValidityLabel(validityDate, params.validityPrefix || "до");
  if (validityLabel) return { kind: "validity", label: validityLabel };
  return params.fallback ? { kind: "validity", label: params.fallback } : null;
}
