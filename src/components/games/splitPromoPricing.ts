import type { PadelSplitPaymentPromoConfig } from "../../utils/apiClient";

type SplitPromoSelection = {
  config: PadelSplitPaymentPromoConfig | null;
  date: string | null | undefined;
  studioId: string | null | undefined;
  studioName: string | null | undefined;
  roomId: string | null | undefined;
  roomName: string | null | undefined;
  shareCount: number;
  durationMinutes: number | null | undefined;
};

function normalizeId(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeName(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim().toLocaleLowerCase("ru-RU");
  return normalized || null;
}

function selectionAllowed(
  allowedIds: string[],
  includeTokens: string[],
  id: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const normalizedId = normalizeId(id);
  const ids = new Set(allowedIds.map(normalizeId).filter((value): value is string => Boolean(value)));
  if (normalizedId && ids.has(normalizedId)) return true;

  const normalizedName = normalizeName(name);
  const tokens = includeTokens
    .map(normalizeName)
    .filter((value): value is string => Boolean(value));
  if (normalizedName && tokens.some((token) => normalizedName.includes(token))) return true;
  return ids.size === 0 && tokens.length === 0;
}

function promoMatches(
  promo: PadelSplitPaymentPromoConfig,
  selection: SplitPromoSelection,
): boolean {
  if (promo.enabled !== true) return false;
  const date = normalizeId(selection.date);
  if (!date) return false;
  if (promo.activeFrom && date < promo.activeFrom) return false;
  if (promo.activeTo && date > promo.activeTo) return false;
  if (!selectionAllowed(
    promo.stationIds,
    promo.stationNameIncludes,
    selection.studioId,
    selection.studioName,
  )) return false;
  return selectionAllowed(
    promo.roomIds,
    promo.roomNameIncludes,
    selection.roomId,
    selection.roomName,
  );
}

export function resolveSplitPromoShareAmount(selection: SplitPromoSelection): number | null {
  if (!selection.config) return null;
  const candidates = selection.config.promos?.length
    ? selection.config.promos
    : [selection.config];
  const promo = candidates.find((candidate) => promoMatches(candidate, selection));
  if (!promo) return null;

  const hourlyAmount = selection.shareCount === 2
    ? promo.shareAmounts.twoTeams
    : promo.shareAmounts.fourPlayers;
  const durationMinutes = Number.isFinite(selection.durationMinutes)
    ? Math.max(1, Math.round(Number(selection.durationMinutes)))
    : 60;
  return Math.max(0, Math.round(hourlyAmount * durationMinutes / 60 * 100) / 100);
}
