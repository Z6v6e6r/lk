import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PAYMENT_SYNC_MAX_ATTEMPTS,
  advancePaymentSyncFailure,
  computePaymentSyncRetryDelayMs,
  isPaymentSyncExhausted,
  removePaymentSyncQueueItem,
  resolvePaymentSyncLookupMode,
  shouldClaimPaymentSyncItem,
  type PaymentSyncRetryState,
} from "../../src/utils/paymentSyncPolicy.ts";

function makeRetryState(overrides: Partial<PaymentSyncRetryState> = {}): PaymentSyncRetryState {
  return {
    attempts: 0,
    nextAttemptTs: 0,
    lastAttemptTs: null,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    status: "pending",
    exhaustedAt: null,
    ...overrides,
  };
}

function extractFunctionBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Cannot find marker: ${marker}`);
  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `Cannot find body for: ${marker}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  assert.fail(`Cannot extract function body for: ${marker}`);
}

test("payment lookup supports one-query exact modes and the callback fallback", () => {
  const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  const block = extractFunctionBlock(
    source,
    "export async function apiFetchPadelGameByPaymentRef",
  );

  assert.match(block, /request<unknown>\(`\/lk\/games\?\$\{query\.toString\(\)\}`/);
  assert.match(block, /options\?\.mode \?\? "sequential"/);
  assert.match(block, /lookupMode === "combined"/);
  assert.match(block, /combinedQuery\.set\("paymentRef", paymentRef\)/);
  assert.match(block, /combinedQuery\.set\("bookingIds", bookingIds\.join\(","\)\)/);
  assert.match(block, /lookupMode === "paymentRef"/);
  assert.match(block, /lookupMode === "bookingIds"/);
  assert.match(block, /lookupMode === "sequential" && bookingIds\.length > 0/);
  assert.doesNotMatch(block, /\/lk\/games\/by-payment-ref/);
  assert.doesNotMatch(block, /\/lk\/games\/by-phone/);
  assert.equal(block.match(/request<unknown>\(/g)?.length, 1);
  assert.match(block, /status: lastRequestError \? lastRequestErrorStatus : lastStatus/);
});

test("lookup transport errors stay in retry flow instead of creating a duplicate game", () => {
  const source = fs.readFileSync("src/utils/paymentSync.ts", "utf8");
  const lookupStart = source.indexOf("const byPaymentRef = await apiFetchPadelGameByPaymentRef");
  const lookupErrorGuard = source.indexOf("const lookupErrorStatus = Number(", lookupStart);
  const draftLookup = source.indexOf("const draft = persistedRecord", lookupStart);

  assert.ok(lookupErrorGuard >= 0, "missing lookup transport error guard");
  assert.ok(lookupErrorGuard < draftLookup, "transport errors must stop before confirm/create");
});

test("background retries stay paymentRef-bound while forced callbacks keep immediate fallback", () => {
  assert.equal(resolvePaymentSyncLookupMode({
    forcedCallback: false,
  }), "paymentRef");
  assert.equal(resolvePaymentSyncLookupMode({
    forcedCallback: true,
  }), "sequential");

  for (let attempt = 1; attempt <= PAYMENT_SYNC_MAX_ATTEMPTS; attempt += 1) {
    assert.equal(
      resolvePaymentSyncLookupMode({ forcedCallback: false }),
      "paymentRef",
      `retry ${attempt} must not bypass a paymentRef collision via bookingIds`,
    );
  }

  const syncSource = fs.readFileSync("src/utils/paymentSync.ts", "utf8");
  assert.match(syncSource, /forcedCallback: forcePaymentRef === paymentRef/);
  assert.match(syncSource, /isPaymentSyncRecordBoundToPaymentRef\(lookupRecord, paymentRef\)/);
  assert.equal(syncSource.match(/\{ mode: "combined" \}/g)?.length, 2);

  const persistenceSource = fs.readFileSync("src/utils/serverGameDraftPersistence.ts", "utf8");
  assert.match(persistenceSource, /lookupDraft:[\s\S]*\{ mode: "combined" \}/);
});

test("payment retry backoff starts at 10 seconds and caps at 10 minutes", () => {
  assert.equal(computePaymentSyncRetryDelayMs(1), 10_000);
  assert.equal(computePaymentSyncRetryDelayMs(2), 20_000);
  assert.equal(computePaymentSyncRetryDelayMs(6), 320_000);
  assert.equal(computePaymentSyncRetryDelayMs(7), 600_000);
  assert.equal(computePaymentSyncRetryDelayMs(20), 600_000);
});

test("the twentieth failed attempt makes an item terminal", () => {
  let state = makeRetryState();
  let now = 1_000;

  for (let attempt = 1; attempt <= PAYMENT_SYNC_MAX_ATTEMPTS; attempt += 1) {
    assert.equal(shouldClaimPaymentSyncItem(state, now), true);
    state = advancePaymentSyncFailure(state, `failure-${attempt}`, now);
    assert.equal(state.attempts, attempt);

    if (attempt < PAYMENT_SYNC_MAX_ATTEMPTS) {
      assert.equal(state.status, "pending");
      assert.equal(isPaymentSyncExhausted(state), false);
      now = state.nextAttemptTs;
    }
  }

  assert.equal(state.attempts, 20);
  assert.equal(state.status, "exhausted");
  assert.equal(isPaymentSyncExhausted(state), true);
  assert.equal(state.nextAttemptTs, Number.MAX_SAFE_INTEGER);
  assert.equal(shouldClaimPaymentSyncItem(state, Number.MAX_SAFE_INTEGER), false);

  const unchanged = advancePaymentSyncFailure(state, "explicit callback failed", now + 1);
  assert.equal(unchanged.attempts, 20);
  assert.equal(unchanged.exhaustedAt, state.exhaustedAt);
});

test("terminal items stay excluded across reload and focus-like processing", () => {
  const terminal = advancePaymentSyncFailure(
    makeRetryState({ attempts: 19 }),
    "last automatic failure",
    42_000,
  );
  const restored = JSON.parse(JSON.stringify(terminal)) as PaymentSyncRetryState;

  for (const source of ["app_boot", "app_focus", "app_visible", "academy_boot"]) {
    assert.equal(
      shouldClaimPaymentSyncItem(restored, Number.MAX_SAFE_INTEGER),
      false,
      `${source} must not reclaim an exhausted item`,
    );
  }

  assert.equal(
    shouldClaimPaymentSyncItem(restored, Number.MAX_SAFE_INTEGER, true),
    false,
    "an explicit payment callback must not bypass the 20-attempt ceiling",
  );

  const legacyTerminal = makeRetryState({ attempts: 20, status: undefined });
  assert.equal(isPaymentSyncExhausted(legacyTerminal), true);
  assert.equal(shouldClaimPaymentSyncItem(legacyTerminal, Number.MAX_SAFE_INTEGER), false);
});

test("browser queue processing is serialized across tabs with a Web Lock", () => {
  const source = fs.readFileSync("src/utils/paymentSync.ts", "utf8");

  assert.match(source, /const PAYMENT_SYNC_WEB_LOCK_NAME = "padlhub\.payment-sync\.v1"/);
  assert.match(source, /navigator\.locks/);
  assert.match(source, /if \(toStringSafe\(options\?\.forcePaymentRef\)\)[\s\S]*\{ mode: "exclusive" \}/);
  assert.match(source, /\{ mode: "exclusive", ifAvailable: true \}/);
  assert.match(source, /if \(!lock\) return buildSkippedPaymentSyncResult\(\)/);
});

test("successful reconciliation removes only its queue item", () => {
  const first = makeRetryState({ attempts: 3 });
  const second = makeRetryState({ attempts: 1 });
  const store = { "pay-first": first, "pay-second": second };
  const cleaned = removePaymentSyncQueueItem(store, "pay-first");

  assert.deepEqual(Object.keys(cleaned), ["pay-second"]);
  assert.equal(cleaned["pay-second"], second);
  assert.deepEqual(Object.keys(store).sort(), ["pay-first", "pay-second"]);

  const syncSource = fs.readFileSync("src/utils/paymentSync.ts", "utf8");
  const resolvedBlock = extractFunctionBlock(
    syncSource,
    "export function markPendingPaymentSyncResolved",
  );
  assert.match(resolvedBlock, /removePaymentSyncQueueItem\(queue, paymentRef\)/);
  assert.match(resolvedBlock, /removePendingPaidGameDraft\(paymentRef\)/);
});
