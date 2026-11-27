import { subscriptionPriceSelectionKey, type SubscriptionPriceTarget } from "../components/games/subscriptionPricePreview.ts";

export type PilotOfferTarget = SubscriptionPriceTarget | { targetKind: "GROUP_TRAINING" | "TOURNAMENT"; exerciseId: string };

export type RaBoostPreview = {
  kind: "RA_BOOST";
  mode: "offer" | "included";
  selectionKey: string;
  productId: string;
  durationDays: number;
  participationAmountMinor: number;
  productAmountMinor: number;
  basePriceMinor: number;
  baseAmountMinor: number;
  baseSubscriptionId: string;
  basePlan: "residency" | "friendship" | "friendship-2" | "ra";
  expiresAt: number;
};

export function pilotOfferSelectionKey(target: PilotOfferTarget) {
  return "exerciseId" in target
    ? JSON.stringify([target.targetKind, target.exerciseId])
    : subscriptionPriceSelectionKey(target);
}

export function readRaBoostPreview(data: unknown, selectionKey: string, elapsedMs: number): RaBoostPreview | null {
  if (data === null || typeof data !== "object") return null;
  const { pilotOffer, serverTimeMs } = data as { pilotOffer?: RaBoostPreview; serverTimeMs?: number };
  const quote = pilotOffer;
  const uuid = (value: unknown): value is string => typeof value === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  if (!quote || quote.kind !== "RA_BOOST" || quote.selectionKey !== selectionKey
    || !uuid(quote.productId) || !uuid(quote.baseSubscriptionId)
    || !["residency", "friendship", "friendship-2", "ra"].includes(quote.basePlan)
    || !Number.isSafeInteger(quote.durationDays) || quote.durationDays < 1 || quote.durationDays > 365
    || !Number.isSafeInteger(quote.baseAmountMinor) || quote.baseAmountMinor > quote.basePriceMinor
    || quote.baseAmountMinor <= quote.participationAmountMinor
    || !Number.isSafeInteger(quote.basePriceMinor) || !Number.isSafeInteger(quote.participationAmountMinor)
    || !Number.isSafeInteger(quote.productAmountMinor) || quote.productAmountMinor > 100_000_000
    || quote.participationAmountMinor < 0 || quote.participationAmountMinor >= quote.basePriceMinor
    || (quote.mode === "offer" ? quote.productAmountMinor <= 0
      : quote.mode !== "included" || quote.productAmountMinor !== 0)
    || !Number.isSafeInteger(serverTimeMs) || serverTimeMs! <= 0
    || !Number.isFinite(elapsedMs) || elapsedMs < 0
    || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= serverTimeMs! + elapsedMs
    || quote.expiresAt > serverTimeMs! + 30_000) return null;
  return { ...quote, expiresAt: Date.now() + quote.expiresAt - serverTimeMs! - elapsedMs };
}
