export interface NewGameSubscriptionPriceTarget {
  targetKind: "NEW_GAME";
  slotId: string;
  stationId: string;
  roomId: string;
  masterServiceId: string;
  subServiceIds: string[];
  startsAt: string;
  durationMinutes: 60 | 90 | 120;
  shareCount: 2 | 4;
}

export interface ExistingGameSubscriptionPriceTarget {
  targetKind: "EXISTING_GAME";
  gameId: string;
  startsAt: string;
  durationMinutes: 60 | 90 | 120;
}

export type SubscriptionPriceTarget = NewGameSubscriptionPriceTarget | ExistingGameSubscriptionPriceTarget;

export function createJoinSubscriptionPriceTarget(input: {
  gameId: string | null; date: string | null; fromTime: string | null; durationMinutes: number;
}): ExistingGameSubscriptionPriceTarget | null {
  if (!input.gameId || !input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || !input.fromTime || !/^\d{2}:\d{2}(?::\d{2})?$/.test(input.fromTime)
    || ![60, 90, 120].includes(input.durationMinutes)) return null;
  return { targetKind: "EXISTING_GAME", gameId: input.gameId,
    startsAt: `${input.date}T${input.fromTime.length === 5 ? input.fromTime + ":00" : input.fromTime}+03:00`, durationMinutes: input.durationMinutes as 60 | 90 | 120 };
}

/** Shared by production and DEV; payment-demo/shadow modes never control this read. */
export function createSubscriptionPriceTarget(input: {
  slotId: string | null; stationId: string | null; roomId: string | null;
  masterServiceId: string | null; subServiceIds: string[];
  date: string | null; fromTime: string | null; durationMinutes: number; shareCount: number;
}): NewGameSubscriptionPriceTarget | null {
  if (!input.slotId || !input.stationId || !input.roomId || !input.masterServiceId
    || !input.subServiceIds.length || input.subServiceIds.some(id => !id)
    || !input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || !input.fromTime || !/^\d{2}:\d{2}$/.test(input.fromTime)
    || ![60, 90, 120].includes(input.durationMinutes) || ![2, 4].includes(input.shareCount)) return null;
  return {targetKind: "NEW_GAME", slotId: input.slotId, stationId: input.stationId, roomId: input.roomId,
    masterServiceId: input.masterServiceId, subServiceIds: [...input.subServiceIds],
    startsAt: `${input.date}T${input.fromTime}:00+03:00`, durationMinutes: input.durationMinutes as 60 | 90 | 120,
    shareCount: input.shareCount as 2 | 4};
}

export interface SubscriptionPriceQuote {
  subscriptionId: string;
  selectionKey: string;
  status: "AVAILABLE" | "LIMIT_USED" | "UNAVAILABLE";
  basePriceMinor: number;
  amountMinor: number | null;
  freeMinutes: number;
  paidMinutes: number;
  reasonCode: string;
  evaluatedAt: number;
  expiresAt: number;
}

export type SubscriptionPricePreview = {
  state: "checking" | "available" | "limit-used" | "unavailable";
  label: string;
  detail: string | null;
  basePriceMinor: number | null;
  amountMinor: number | null;
  discounted: boolean;
};

export function subscriptionPriceSelectionKey(target: SubscriptionPriceTarget): string {
  if (target.targetKind === "EXISTING_GAME") return JSON.stringify([target.targetKind, target.gameId, target.startsAt, target.durationMinutes]);
  return JSON.stringify([target.slotId, target.stationId, target.roomId, target.masterServiceId,
    [...target.subServiceIds].sort(), target.startsAt, target.durationMinutes, target.shareCount]);
}

const money = (minor: number): string => new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
}).format(minor / 100);
const minorUnits = (value: unknown): value is number => Number.isSafeInteger(value)
  && Number(value) >= 0 && Number(value) <= 1_000_000;
const empty = (state: "checking" | "limit-used" | "unavailable", label: string): SubscriptionPricePreview => ({
  state, label, detail: null, basePriceMinor: null, amountMinor: null, discounted: false,
});

/** Only complete, current server quotes may replace the ordinary price. No local benefit calculation. */
export function subscriptionPricePreview(input: {
  selectionKey: string;
  durationMinutes: number;
  subscriptionIds: string[];
  quotes: SubscriptionPriceQuote[] | null;
  loading: boolean;
  now: number;
}): SubscriptionPricePreview {
  if (input.loading) return empty("checking", "Проверяем подписки…");
  const unavailable = () => empty("unavailable", "Условия подписки не подтверждены");
  const ids = [...new Set(input.subscriptionIds)];
  if (!ids.length) return empty("unavailable", "Нет доступной подписки");
  const quotes = input.quotes;
  if (!Array.isArray(quotes) || quotes.some(q => !q || typeof q !== "object")
    || quotes.length !== ids.length || new Set(quotes.map(q => q.subscriptionId)).size !== ids.length
    || quotes.some(q => !ids.includes(q.subscriptionId) || q.selectionKey !== input.selectionKey
      || !["AVAILABLE", "LIMIT_USED", "UNAVAILABLE"].includes(q.status)
      || !Number.isFinite(q.evaluatedAt) || !Number.isFinite(q.expiresAt)
      || q.evaluatedAt > input.now + 5000 || q.expiresAt <= input.now
      || q.expiresAt <= q.evaluatedAt || q.expiresAt - q.evaluatedAt > 60_000
      || !minorUnits(q.basePriceMinor))) return unavailable();
  // A canonical tariff mismatch is uncertainty, not a reason to advertise a smaller amount.
  if (new Set(quotes.map(q => q.basePriceMinor)).size !== 1) return unavailable();
  const available = quotes.filter(q => q.status === "AVAILABLE");
  if (available.some(q => !minorUnits(q.amountMinor) || q.amountMinor > q.basePriceMinor
    || !Number.isSafeInteger(q.freeMinutes) || q.freeMinutes < 0
    || !Number.isSafeInteger(q.paidMinutes) || q.paidMinutes < 0
    || q.freeMinutes + q.paidMinutes !== input.durationMinutes)) return unavailable();
  if (!available.length) return quotes.some(q => q.status === "LIMIT_USED")
    ? empty("limit-used", "Лимит по подписке исчерпан")
    : empty("unavailable", "Подписка недоступна для этого времени");
  const best = [...available].sort((a, b) => a.amountMinor! - b.amountMinor!
    || a.subscriptionId.localeCompare(b.subscriptionId))[0];
  const amountMinor = best.amountMinor!;
  return {
    state: "available", label: `По подписке от ${money(amountMinor)} ₽`,
    detail: best.paidMinutes > 0 ? `Доплата за ${best.paidMinutes} мин` : null,
    basePriceMinor: best.basePriceMinor, amountMinor,
    discounted: amountMinor < best.basePriceMinor,
  };
}


/** Validate the whole batch before presenting any individual subscription price. */
export function subscriptionPricePreviewsById(input: Parameters<typeof subscriptionPricePreview>[0]): Record<string, SubscriptionPricePreview> {
  const batch = subscriptionPricePreview(input);
  return Object.fromEntries([...new Set(input.subscriptionIds)].map(id => [id,
    batch.state === "available" || batch.state === "limit-used"
      ? subscriptionPricePreview({...input, subscriptionIds: [id], quotes: input.quotes!.filter(q => q.subscriptionId === id)})
      : batch,
  ]));
}
