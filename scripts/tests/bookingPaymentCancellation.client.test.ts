import test from "node:test";
import assert from "node:assert/strict";
import { BookingPaymentCancellation, bookingPaymentCancellation, canCancelBookingPaymentAttempt, setBookingPaymentCancellationSessionReader,
  PAYMENT_CANCELLATION_CLOSED, PAYMENT_CANCELLATION_PAID } from "../../src/utils/bookingPaymentCancellation.ts";
import { canOpenPaymentAttempt, paymentAttemptFields } from "../../src/utils/paymentAttemptLifecycle.ts";
const target = { bookingId: "booking", transactionId: "transaction", gameId: "game" };
const actor = "actor", session = () => "opaque-session";
const reply = (state: string, status = state === "CLOSING" ? 202 : 200, extra = {}) => ({ status, error: null,
  data: { ...target, actorClientId: actor, state, paymentUrl: null,
    cancelled: state === "CLOSED", limitReleased: state === "CLOSED", paid: state === "PAID", ...extra } });
const generic = { status: 200, error: null, data: { ok: true, cancelledInLk: true } };
const storage = () => { const rows = new Map<string, string>(); return { getItem: (key: string) => rows.get(key) || null,
  setItem: (key: string, value: string) => { rows.set(key, value); } }; };
const wait = async () => {};
test("only server-managed checkout capability enables cancel, even after its link expires", () => {
  assert.equal(canCancelBookingPaymentAttempt(target), false);
  assert.equal(canCancelBookingPaymentAttempt({ ...target, paymentAttemptHeadKey: "unmanaged" }), false);
  assert.equal(canCancelBookingPaymentAttempt({ ...target, paymentAttemptCancelSupported: true, paymentExpiresAt: "2000-01-01T00:00:00Z" }), true);
  assert.equal(canCancelBookingPaymentAttempt({ ...target, paymentAttemptHeadKey: "booking-payment-head:managed" }), true);
  assert.equal(canCancelBookingPaymentAttempt({ ...target, paymentAttemptCancelSupported: false, paymentAttemptHeadKey: "booking-payment-head:managed" }), false);
  assert.equal(paymentAttemptFields({ raw: { paymentAttemptCancelSupported: true } }).paymentAttemptCancelSupported, true);
  assert.equal(paymentAttemptFields({ paymentAttemptCancelSupported: false, raw: { paymentAttemptCancelSupported: true } }).paymentAttemptCancelSupported, false);
});

test("one explicit POST is always followed by normalized GET; only exact CLOSED releases the limit", async () => {
  const controller = new BookingPaymentCancellation({ storage: null }), calls: string[] = [];
  const result = await controller.cancel(target, actor, { session, wait, send: async method => {
    calls.push(method); return method === "POST" ? generic : reply("CLOSED");
  } });
  assert.deepEqual(calls, ["POST", "GET"]);
  assert.equal(result.state, "CLOSED"); assert.equal(result.message, PAYMENT_CANCELLATION_CLOSED);
  assert.equal(controller.blocks(target, session()), true);
});
test("generic cleanup success and unbound CLOSED never invent released-credit success", async () => {
  for (const read of [generic, reply("CLOSED", 200, { transactionId: "other" }), reply("CLOSED", 200, { actorClientId: "other" }),
    reply("CLOSED", 200, { limitReleased: false }), reply("CLOSED", 200, { cancelled: false })]) {
    const c = new BookingPaymentCancellation({ storage: null });
    const result = await c.cancel(target, actor, { session, wait, attempts: 1, send: async method => method === "POST" ? generic : read });
    assert.equal(result.state, "CLOSING"); assert.notEqual(result.message, PAYMENT_CANCELLATION_CLOSED);
  }
});
test("payment wins the race and cancellation never claims a refund or released credit", async () => {
  const c = new BookingPaymentCancellation({ storage: null });
  const result = await c.cancel(target, actor, { session, wait, send: async method => method === "POST" ? generic : reply("PAID") });
  assert.equal(result.state, "PAID"); assert.equal(result.message, PAYMENT_CANCELLATION_PAID);
  assert.equal(c.blocks(target, session()), true);
});
test("concurrent clicks share one dispatch and block the stale link before the POST resolves", async () => {
  const c = new BookingPaymentCancellation({ storage: null }); let posts = 0;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const options = { session, wait, send: async (method: "POST" | "GET") => {
    if (method === "POST") { posts++; await gate; return generic; } return reply("CLOSED");
  } };
  const first = c.cancel(target, actor, options), second = c.cancel(target, actor, options);
  assert.equal(first, second); assert.equal(posts, 1); assert.equal(c.blocks(target, session()), true);
  release(); assert.equal((await first).state, "CLOSED");
});
test("ambiguous POST keeps its marker through PAYMENT_REQUIRED and reconciles without reposting", async () => {
  const c = new BookingPaymentCancellation({ storage: null }), calls: string[] = [];
  const reads = [reply("PAYMENT_REQUIRED"), reply("CLOSING"), reply("CLOSED")];
  const result = await c.cancel(target, actor, { session, wait, send: async method => {
    calls.push(method); if (method === "POST") throw Error("timeout after possible dispatch"); return reads.shift()!;
  } });
  assert.equal(result.state, "CLOSED"); assert.deepEqual(calls, ["POST", "GET", "GET", "GET"]);
});
test("exact fresh financial-closure proof permits one roster finalization POST followed by GET", async () => {
  const c = new BookingPaymentCancellation({ storage: null }), calls: string[] = [];
  const reads = [reply("CLOSING", 202, { financiallyClosed: true, needsFinalization: true }), reply("CLOSED")];
  const result = await c.cancel(target, actor, { session, wait, attempts: 1, send: async method => {
    calls.push(method); return method === "POST" ? generic : reads.shift()!;
  } });
  assert.equal(result.state, "CLOSED");
  assert.deepEqual(calls, ["POST", "GET", "POST", "GET"]);
});
test("missing, false, unbound or failed financial-closure proof never permits the additional POST", async () => {
  for (const extra of [{ financiallyClosed: true }, { needsFinalization: true },
    { financiallyClosed: false, needsFinalization: true }, { financiallyClosed: true, needsFinalization: false },
    { financiallyClosed: true, needsFinalization: true, actorClientId: "other" },
    { financiallyClosed: true, needsFinalization: true, transactionId: "other" },
    { financiallyClosed: true, needsFinalization: true, bookingId: "other" },
    { financiallyClosed: true, needsFinalization: true, gameId: "other" },
    { financiallyClosed: true, needsFinalization: true, gameId: null },
    { financiallyClosed: true, needsFinalization: true, paid: true }]) {
    const c = new BookingPaymentCancellation({ storage: null }), calls: string[] = [];
    await c.cancel(target, actor, { session, wait, attempts: 1, send: async method => {
      calls.push(method); return method === "POST" ? generic : reply("CLOSING", 202, extra);
    } });
    assert.deepEqual(calls, ["POST", "GET"]);
  }
  const c = new BookingPaymentCancellation({ storage: null }), calls: string[] = [];
  await c.cancel(target, actor, { session, wait, send: async method => {
    calls.push(method); return method === "POST" ? generic : { status: 503, data: null,
      error: { message: "review", raw: reply("CLOSING", 202, { financiallyClosed: true, needsFinalization: true }).data } };
  } });
  assert.deepEqual(calls, ["POST", "GET"]);
});
test("an ambiguous finalization dispatch is never repeated by subsequent polls", async () => {
  const c = new BookingPaymentCancellation({ storage: null }), calls: string[] = [];
  let posts = 0;
  const result = await c.cancel(target, actor, { session, wait, attempts: 3, send: async method => {
    calls.push(method);
    if (method === "POST") { if (++posts === 2) throw Error("finalizer ACK lost"); return generic; }
    return reply("CLOSING", 202, { financiallyClosed: true, needsFinalization: true });
  } });
  assert.equal(result.state, "CLOSING"); assert.equal(posts, 2);
  assert.deepEqual(calls, ["POST", "GET", "POST", "GET", "GET", "GET"]);
  assert.equal(c.blocks(target, session()), true);
});
test("a later explicit check may finalize once again only after a new exact GET proof", async () => {
  const c = new BookingPaymentCancellation({ storage: null });
  await c.cancel(target, actor, { session, wait, attempts: 1, send: async method => method === "POST" ? generic : reply("CLOSING") });
  const calls: string[] = [], reads = [reply("CLOSING", 202, { financiallyClosed: true, needsFinalization: true }), reply("CLOSED")];
  const result = await c.cancel(target, actor, { session, wait, attempts: 1, send: async method => {
    calls.push(method); return method === "POST" ? generic : reads.shift()!;
  } });
  assert.equal(result.state, "CLOSED"); assert.deepEqual(calls, ["GET", "POST", "GET"]);
});
test("accepted and ambiguous cancellation survives reload and a later click performs GET only", async () => {
  const saved = storage(), c = new BookingPaymentCancellation({ storage: saved });
  assert.equal((await c.cancel(target, actor, { session, wait, attempts: 1,
    send: async method => method === "POST" ? generic : reply("CLOSING") })).state, "CLOSING");
  const restored = new BookingPaymentCancellation({ storage: saved }), calls: string[] = [];
  assert.equal(restored.state(target, actor, session()), "CLOSING");
  assert.equal(restored.blocks(target, "another-session"), false);
  assert.equal(restored.state(target, "another-actor", session()), null);
  await restored.cancel(target, actor, { session, wait, send: async method => { calls.push(method); return reply("CLOSED"); } });
  assert.deepEqual(calls, ["GET"]);
  assert.ok(!saved.getItem("padlhub:booking-payment-cancellation:v1")!.includes(session()));
});
test("explicit pre-mutation controller refusals remain errors without a cancellation marker", async () => {
  for (const [status, code] of [[400, "PAYMENT_CANCEL_INPUT_INVALID"], [401, "PAYMENT_CANCEL_ACTOR_UNVERIFIED"],
    [401, "PAYMENT_CANCEL_AUTH_REQUIRED"], [404, "PAYMENT_CANCEL_ATTEMPT_NOT_FOUND"],
    [405, "PAYMENT_CANCEL_METHOD_INVALID"], [503, "PAYMENT_CANCEL_UNAVAILABLE"]] as const) {
    const c = new BookingPaymentCancellation({ storage: null });
    const result = await c.cancel(target, actor, { session, wait, send: async () => ({ status, data: null,
      error: { message: "not accepted", raw: { ...target, actorClientId: actor, code, accepted: false } } }) });
    assert.equal(result.state, "ERROR"); assert.equal(c.state(target, actor, session()), null);
  }
});
test("generic POST409 and HTML404 followed by an unavailable GET cannot unblock a possibly accepted cancellation", async () => {
  for (const post of [{ status: 409, data: null, error: { message: "CAS miss", raw: { code: "SPLIT_CLEANUP_CAS_MISS" } } },
    { status: 403, data: null, error: { message: "cleanup ownership changed" } },
    { status: 404, data: null, error: { message: "not found", raw: "<html>Not found</html>" } }]) {
    const c = new BookingPaymentCancellation({ storage: null }), calls: string[] = [];
    const result = await c.cancel(target, actor, { session, wait, send: async method => {
      calls.push(method); return method === "POST" ? post : { status: 503, data: null, error: { message: "unavailable" } };
    } });
    assert.equal(result.state, "ERROR"); assert.equal(c.blocks(target, session()), true);
    assert.deepEqual(calls, ["POST", "GET"]);
  }
});
test("a refusal code with contradictory status, ownership or acceptance never clears the marker", async () => {
  for (const post of [
    { status: 409, raw: { ...target, actorClientId: actor, code: "PAYMENT_CANCEL_ATTEMPT_NOT_FOUND" } },
    { status: 404, raw: { ...target, actorClientId: "other", code: "PAYMENT_CANCEL_ATTEMPT_NOT_FOUND" } },
    { status: 404, raw: { code: "PAYMENT_CANCEL_ATTEMPT_NOT_FOUND" } },
    { status: 404, raw: { ...target, actorClientId: actor, code: "PAYMENT_CANCEL_ATTEMPT_NOT_FOUND", accepted: true } },
  ]) {
    const c = new BookingPaymentCancellation({ storage: null });
    await c.cancel(target, actor, { session, wait, send: async method => method === "POST"
      ? { status: post.status, data: null, error: { message: "refused", raw: post.raw } }
      : { status: 503, data: null, error: { message: "unavailable" } } });
    assert.equal(c.blocks(target, session()), true);
  }
});
test("HTTP503 without a receipt remains ambiguous and cannot re-enable the old checkout", async () => {
  const c = new BookingPaymentCancellation({ storage: null });
  const result = await c.cancel(target, actor, { session, wait, send: async () => ({ status: 503, data: null, error: { message: "unavailable" } }) });
  assert.equal(result.state, "ERROR"); assert.equal(c.state(target, actor, session()), "CLOSING");
  assert.notEqual(result.message, PAYMENT_CANCELLATION_CLOSED);
});
test("a failed read after accepted dispatch keeps the block and never claims cancellation", async () => {
  const c = new BookingPaymentCancellation({ storage: null });
  const result = await c.cancel(target, actor, { session, wait, send: async method => method === "POST" ? generic
    : { status: 503, data: { state: "REVIEW" }, error: { message: "review required" } } });
  assert.equal(result.state, "ERROR"); assert.equal(c.state(target, actor, session()), "CLOSING");
});
test("accepted REVIEW carried by API error.raw preserves the marker despite HTTP503", async () => {
  const c = new BookingPaymentCancellation({ storage: null });
  const result = await c.cancel(target, actor, { session, wait, send: async () => ({ status: 503, data: null,
    error: { message: "review required", raw: { ...target, actorClientId: actor, state: "REVIEW", accepted: true } } }) });
  assert.equal(result.state, "ERROR"); assert.equal(c.state(target, actor, session()), "CLOSING");
});
test("session changes discard late responses and never run the next request", async () => {
  let token = "first", calls = 0;
  const c = new BookingPaymentCancellation({ storage: null });
  const result = await c.cancel(target, actor, { session: () => token, wait, send: async () => {
    calls++; token = "second"; return reply("CLOSED");
  } });
  assert.equal(result.state, "ERROR"); assert.equal(calls, 1);
  assert.equal(c.state(target, actor, "second"), null);
  assert.equal(c.state(target, actor, "first"), "CLOSING");
});
test("the shared navigation guard blocks cancelled checkouts before expiry and never renews expired URLs", async () => {
  setBookingPaymentCancellationSessionReader(session);
  await bookingPaymentCancellation().cancel(target, actor, { session, wait, attempts: 1,
    send: async method => method === "POST" ? generic : reply("CLOSING") });
  const now = Date.now(), payment = { ...target, paymentUrl: "https://pay.example.com/old", paymentExpiresAt: new Date(now + 60000).toISOString() };
  assert.equal(canOpenPaymentAttempt(payment, now), false);
  assert.equal(canOpenPaymentAttempt({ ...payment, transactionId: "fresh" }, now), true);
  assert.equal(canOpenPaymentAttempt({ ...payment, transactionId: "fresh", paymentExpiresAt: new Date(now - 1).toISOString() }, now), false);
});
