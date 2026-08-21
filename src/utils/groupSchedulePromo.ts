import type {
  TournamentVivaProduct,
  TournamentVivaTransactionPreview,
} from "./tournamentSignupApi";

export interface AppliedGroupSchedulePromo {
  code: string;
  previewsByProductId: Record<string, TournamentVivaTransactionPreview>;
}

export function normalizeGroupSchedulePromoCode(value: string): string {
  return value.trim().toLocaleUpperCase("ru-RU");
}

export function isGroupSchedulePromoProduct(product: TournamentVivaProduct): boolean {
  return product.source === "one-time";
}

export function isGroupSchedulePromoPreviewApplicable(
  preview: TournamentVivaTransactionPreview,
): boolean {
  return preview.discountMinor > 0 && preview.toPayMinor < preview.sumMinor;
}

export function getAppliedGroupSchedulePromoPreview(
  promo: AppliedGroupSchedulePromo | null,
  product: TournamentVivaProduct,
): TournamentVivaTransactionPreview | null {
  if (!promo || !isGroupSchedulePromoProduct(product)) return null;
  return promo.previewsByProductId[product.id] ?? null;
}
