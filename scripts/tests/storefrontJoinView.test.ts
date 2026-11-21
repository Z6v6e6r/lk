import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmLabel,
  resolveSelectedOption,
  resolveStorefrontJoinView,
  type StorefrontJoinInput,
} from "../../src/components/storefront-checkout/storefrontJoinView.ts";

const base: StorefrontJoinInput = {
  oneTimeAmount: 1500,
  subscriptionsLoading: false,
  subscriptionsError: null,
  subscriptions: [],
  pending: null,
  hasLeaveOnlyPayment: false,
  canJoin: true,
  canLeave: false,
  busy: false,
  leaving: false,
  error: null,
  outcomeUnknown: false,
};
const rub = (value: number) => `${value} ₽`;

test("a server PAYMENT_PENDING item keeps the awaiting-payment state and never offers a new payment choice", () => {
  const view = resolveStorefrontJoinView({ ...base, pending: { paymentUrl: " https://pay.example/x ", countdownLabel: "12:30", expired: false }, canLeave: true });
  assert.equal(view.kind, "awaiting-payment");
  assert.equal(view.kind === "awaiting-payment" && view.paymentUrl, "https://pay.example/x");
  assert.equal("options" in view, false);
});

test("a pending item without a link stays awaiting-payment with the pay action disabled", () => {
  const view = resolveStorefrontJoinView({ ...base, pending: { paymentUrl: "", countdownLabel: null, expired: false } });
  assert.equal(view.kind, "awaiting-payment");
  assert.equal(view.kind === "awaiting-payment" && view.paymentUrl, null);
});

test("an expired pending item is not rendered as payable; the server roster decides the next state", () => {
  const view = resolveStorefrontJoinView({ ...base, pending: { paymentUrl: "https://pay.example/x", countdownLabel: "00:00", expired: true } });
  assert.notEqual(view.kind, "awaiting-payment");
});

test("an active non-pending split payment only allows leaving", () => {
  const view = resolveStorefrontJoinView({ ...base, hasLeaveOnlyPayment: true, canLeave: true });
  assert.equal(view.kind, "leave-only");
});

test("no view kind can report a local paid or joined result", () => {
  const inputs: StorefrontJoinInput[] = [base, { ...base, busy: true }, { ...base, error: "x" }, { ...base, hasLeaveOnlyPayment: true },
    { ...base, pending: { paymentUrl: "u", countdownLabel: null, expired: false } }];
  for (const input of inputs) assert.ok(["choose", "awaiting-payment", "leave-only"].includes(resolveStorefrontJoinView(input).kind));
});

test("unknown one-time price is not selectable and is never treated as free", () => {
  for (const amount of [null, 0]) {
    const view = resolveStorefrontJoinView({ ...base, oneTimeAmount: amount });
    assert.equal(view.kind, "choose");
    const oneTime = view.kind === "choose" ? view.options.find(option => option.method.kind === "one_time") : null;
    assert.equal(oneTime?.selectable, false);
  }
});

test("a subscription is selectable only with an available server quote", () => {
  const view = resolveStorefrontJoinView({ ...base, subscriptions: [
    { subscriptionId: "a", name: "Дружба", balanceLabel: "до 01.12", priceState: "available" },
    { subscriptionId: "b", name: "РА", balanceLabel: "до 02.12", priceState: "checking" },
    { subscriptionId: "c", name: "Энергия", balanceLabel: "до 03.12", priceState: null },
  ] });
  assert.equal(view.kind, "choose");
  const selectable = view.kind === "choose" ? view.options.filter(option => option.selectable).map(option => option.key) : [];
  assert.deepEqual(selectable, ["subscription:a", "one_time"]);
});

test("subscriptions are hidden while loading or after a load error, one-time remains with its server price", () => {
  for (const input of [{ ...base, subscriptionsLoading: true }, { ...base, subscriptionsError: "Ошибка" }]) {
    const view = resolveStorefrontJoinView({ ...input, subscriptions: [{ subscriptionId: "a", name: "A", balanceLabel: "", priceState: "available" }] });
    assert.equal(view.kind === "choose" && view.options.map(option => option.key).join(","), "one_time");
  }
});

test("a previously selected option is dropped when fresh server data makes it unavailable", () => {
  const available = resolveStorefrontJoinView({ ...base, subscriptions: [{ subscriptionId: "a", name: "A", balanceLabel: "", priceState: "available" }] });
  const stale = resolveStorefrontJoinView({ ...base, subscriptions: [{ subscriptionId: "a", name: "A", balanceLabel: "", priceState: "checking" }] });
  assert.ok(available.kind === "choose" && resolveSelectedOption(available.options, "subscription:a"));
  assert.equal(stale.kind === "choose" && resolveSelectedOption(stale.options, "subscription:a"), null);
  assert.equal(stale.kind === "choose" && resolveSelectedOption(stale.options, "unknown"), null);
});

test("confirm labels describe the next server step, not an outcome", () => {
  const view = resolveStorefrontJoinView(base);
  const oneTime = view.kind === "choose" ? view.options[0] : null;
  assert.equal(confirmLabel(oneTime, false, rub), "Перейти к оплате · 1500 ₽");
  assert.equal(confirmLabel(oneTime, true, rub), "Готовим запись…");
  assert.equal(confirmLabel(null, false, rub), "Выберите способ записи");
});

test("an unknown join outcome blocks a new checkout even when the handler would allow one", () => {
  const view = resolveStorefrontJoinView({ ...base, outcomeUnknown: true, canJoin: true });
  assert.equal(view.kind, "choose");
  assert.equal(view.kind === "choose" && view.canJoin, false);
  assert.equal(view.kind === "choose" && view.outcomeUnknown, true);
});
