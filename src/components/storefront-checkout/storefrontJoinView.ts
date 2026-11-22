// Server-driven view model for the storefront game-join checkout.
//
// The storefront design (PR #339) originally confirmed locally. In the wired
// mode every visible outcome is derived from the game record and handler state
// that GamesPage already owns. This module never reports "paid" or "joined":
// a confirmed participant is rendered by the roster, outside this block.

export type StorefrontJoinMethod =
  | { kind: "one_time" }
  | { kind: "subscription"; subscriptionId: string };

export interface StorefrontJoinSubscription {
  subscriptionId: string;
  name: string;
  balanceLabel: string;
  /** Exact server quote state; only "available" can be confirmed. */
  priceState: string | null;
}

export interface StorefrontJoinInput {
  /** Server share price for the one-time option; null means unknown. */
  oneTimeAmount: number | null;
  subscriptionsLoading: boolean;
  subscriptionsError: string | null;
  subscriptions: StorefrontJoinSubscription[];
  /** PAYMENT_PENDING item of the current user read from the game record. */
  pending: { paymentUrl: string; countdownLabel: string | null; expired: boolean } | null;
  /** An active split payment that only allows leaving (e.g. reserved, not pending). */
  hasLeaveOnlyPayment: boolean;
  canJoin: boolean;
  canLeave: boolean;
  busy: boolean;
  leaving: boolean;
  error: string | null;
  /** A previous join request ended without a readable outcome; a new checkout is blocked. */
  outcomeUnknown: boolean;
}

export type StorefrontJoinView =
  | { kind: "awaiting-payment"; paymentUrl: string | null; countdownLabel: string | null; canLeave: boolean; leaving: boolean; error: string | null }
  | { kind: "leave-only"; canLeave: boolean; leaving: boolean; error: string | null }
  | {
    kind: "choose";
    loading: boolean;
    loadError: string | null;
    options: StorefrontJoinOption[];
    canJoin: boolean;
    busy: boolean;
    error: string | null;
    outcomeUnknown: boolean;
  };

export interface StorefrontJoinOption {
  key: string;
  method: StorefrontJoinMethod;
  title: string;
  detail: string;
  /** Rouble amount when known; never invented for a subscription quote. */
  amount: number | null;
  selectable: boolean;
}

export function joinMethodKey(method: StorefrontJoinMethod): string {
  return method.kind === "one_time" ? "one_time" : `subscription:${method.subscriptionId}`;
}

export function resolveStorefrontJoinView(input: StorefrontJoinInput): StorefrontJoinView {
  if (input.pending && !input.pending.expired) {
    return {
      kind: "awaiting-payment",
      paymentUrl: input.pending.paymentUrl.trim() || null,
      countdownLabel: input.pending.countdownLabel,
      canLeave: input.canLeave,
      leaving: input.leaving,
      error: input.error,
    };
  }
  if (input.hasLeaveOnlyPayment) {
    return { kind: "leave-only", canLeave: input.canLeave, leaving: input.leaving, error: input.error };
  }
  const options: StorefrontJoinOption[] = [];
  if (!input.subscriptionsLoading && !input.subscriptionsError) {
    for (const subscription of input.subscriptions) {
      const method: StorefrontJoinMethod = { kind: "subscription", subscriptionId: subscription.subscriptionId };
      options.push({
        key: joinMethodKey(method),
        method,
        title: subscription.name,
        detail: subscription.balanceLabel,
        amount: null,
        selectable: subscription.priceState === "available",
      });
    }
  }
  const oneTime: StorefrontJoinMethod = { kind: "one_time" };
  options.push({
    key: joinMethodKey(oneTime),
    method: oneTime,
    title: "Разовое участие",
    detail: "Оплата доли на странице банка",
    amount: input.oneTimeAmount,
    // Unknown price never becomes a free or implicit choice.
    selectable: input.oneTimeAmount != null && input.oneTimeAmount > 0,
  });
  return {
    kind: "choose",
    loading: input.subscriptionsLoading,
    loadError: input.subscriptionsError,
    options,
    canJoin: input.canJoin && !input.outcomeUnknown,
    busy: input.busy,
    error: input.error,
    outcomeUnknown: input.outcomeUnknown,
  };
}

/** The selected option is kept only while it stays selectable on the latest server data. */
export function resolveSelectedOption(options: StorefrontJoinOption[], selectedKey: string | null): StorefrontJoinOption | null {
  if (!selectedKey) return null;
  const option = options.find(item => item.key === selectedKey);
  return option && option.selectable ? option : null;
}

export function confirmLabel(option: StorefrontJoinOption | null, busy: boolean, formatAmount: (value: number) => string): string {
  if (busy) return "Готовим запись…";
  if (!option) return "Выберите способ записи";
  if (option.method.kind === "subscription") return `Записаться по «${option.title}»`;
  return option.amount != null ? `Перейти к оплате · ${formatAmount(option.amount)}` : "Стоимость уточняется";
}
