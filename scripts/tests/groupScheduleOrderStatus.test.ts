import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildGroupScheduleReturnUrl, readGroupSchedulePaymentReturnHint } from "../../src/utils/groupScheduleEntry.ts";
import { resolveGroupScheduleOrderStatus } from "../../src/utils/groupScheduleOrderStatus.ts";

const ID = "4c9f00aa-d286-4a48-ad29-98757bd0ca87";
const BASE = "https://padlhub.su/group-schedule?date=2026-11-20";
const ok = (status: "NONE" | "REGISTERED" | "WAITLIST" | "PAYMENT_PENDING") => ({ state: "ok" as const, registration: { status } });

test("return hint belongs to the same training only and never decides the status alone", () => {
  const success = buildGroupScheduleReturnUrl(BASE, { exerciseId: ID, date: "2026-11-20", paymentStatus: "success" }).toString();
  const failed = buildGroupScheduleReturnUrl(BASE, { exerciseId: ID, date: "2026-11-20", paymentStatus: "failed" }).toString();
  assert.equal(readGroupSchedulePaymentReturnHint(success, ID), "success");
  assert.equal(readGroupSchedulePaymentReturnHint(failed, ID), "failed");
  assert.equal(readGroupSchedulePaymentReturnHint(success, "other-training"), null);
  assert.equal(readGroupSchedulePaymentReturnHint(`${success}&groupPaymentFailed=true`, ID), null, "conflicting flags");
  assert.equal(readGroupSchedulePaymentReturnHint(BASE, ID), null);
  // A success flag with a failed server read is still UNKNOWN, never "paid".
  const status = resolveGroupScheduleOrderStatus({ read: { state: "failed" }, returnHint: "success" });
  assert.equal(status.kind, "UNKNOWN");
  assert.equal(status.allowNewPayment, false);
  assert.match(status.message ?? "", /неизвестен/);
});

test("status after refresh / return / lost network comes from the server read", () => {
  const cases: Array<[Parameters<typeof resolveGroupScheduleOrderStatus>[0], string, boolean]> = [
    [{ read: { state: "loading" }, returnHint: "success" }, "LOADING", false],
    [{ read: { state: "failed" }, returnHint: null }, "UNKNOWN", false],
    [{ read: ok("REGISTERED"), returnHint: "failed" }, "PAID", false],
    [{ read: ok("REGISTERED"), returnHint: null }, "PAID", false],
    [{ read: ok("WAITLIST"), returnHint: null }, "WAITLIST", false],
    [{ read: ok("PAYMENT_PENDING"), returnHint: "success" }, "PAYMENT_PENDING", false],
    [{ read: ok("NONE"), returnHint: "success" }, "PROCESSING", false],
    [{ read: ok("NONE"), returnHint: "failed" }, "PAYMENT_FAILED", true],
    [{ read: ok("NONE"), returnHint: null }, "NONE", true],
    [{ read: { state: "ok", registration: { status: "SOMETHING" as never } }, returnHint: null }, "UNKNOWN", false],
  ];
  for (const [input, kind, allowNewPayment] of cases) {
    const status = resolveGroupScheduleOrderStatus(input);
    assert.equal(status.kind, kind, JSON.stringify(input));
    assert.equal(status.allowNewPayment, allowNewPayment, kind);
  }
  for (const kind of ["UNKNOWN", "PROCESSING", "PAYMENT_PENDING"]) {
    const input = cases.find(([, k]) => k === kind)![0];
    assert.equal(resolveGroupScheduleOrderStatus(input).allowRecheck, true, `${kind} offers a re-check`);
  }
});

test("reopening or refreshing never starts a payment or reopens the payment link", () => {
  const page = readFileSync(new URL("../../src/components/group-schedule/GroupSchedulePage.tsx", import.meta.url), "utf8");
  // The payment link is opened in exactly two places: right after the player's own click created
  // the transaction, and the explicit "Продолжить оплату" button. No effect navigates to it.
  const navigations = [...page.matchAll(/window\.location\.href = ([^;]+);/g)].map(match => match[1].trim());
  assert.deepEqual(navigations, ["result.data.paymentUrl", 'registration.paymentUrl || ""']);
  const button = page.indexOf('window.location.href = registration.paymentUrl || ""');
  assert.ok(page.lastIndexOf("onClick={() => {", button) > page.lastIndexOf("useEffect(", button), "pending link opens on click only");
  // The payment request sits behind the order-status guard, and the options behind allowNewPayment.
  const guard = page.indexOf("if (!orderAllowsNewPaymentRef.current)");
  assert.ok(guard > 0 && guard < page.indexOf("apiCreateTournamentVivaTransaction({"), "guard before the payment request");
  assert.match(page, /&& orderStatus\.allowNewPayment\n\s+&& checkout && \(\n\s+<div className="tournament-signup-payment-options">/);
  assert.match(page, /setRegistration\(registrationResult\.error \? null : registrationResult\.data \?\? null\);/);
  assert.match(page, /window\.addEventListener\("online", onOnline\)/);
});
