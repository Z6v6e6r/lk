import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildPendingPaidGameDraftFromRecord,
  isConfirmedPaymentReadbackBound,
  isPaymentSyncRecordBoundToPaymentRef,
  isPersistedGamePaymentFailedTerminal,
  isPersistedGamePaymentTerminal,
  resolvePaymentSyncExpectedGameId,
} from "../../src/utils/paymentSyncDraftRecovery.ts";

const pendingRecord = {
  id: "game-1",
  tenantKey: "tenant-1",
  revision: 7,
  inviteUrl: "https://padlhub.ru/game-1",
  status: "PAYMENT_PENDING",
  createdAt: "2026-08-26T08:00:00.000Z",
  updatedAt: "2026-08-26T08:01:00.000Z",
  organizer: {
    id: "client-1",
    name: "Организатор",
    phone: "79990000000",
    photo: null,
    rating: "C",
    ratingNumeric: 3,
  },
  booking: {
    studioId: "studio-1",
    studioName: "Студия",
    roomId: "room-1",
    roomName: "Корт",
    masterServiceId: "service-1",
    subServiceIds: ["sub-1"],
    date: "2026-08-30",
    timeFrom: "11:30",
    timeTo: "13:00",
    durationMinutes: 90,
    bookingId: "booking-1",
    bookingIds: ["booking-1"],
    exerciseId: "exercise-1",
  },
  payment: {
    amount: 1800,
    paymentUrl: "https://pay.example/1",
    paid: false,
  },
  settings: {
    ratingGame: true,
    minRating: "C-",
    maxRating: "C+",
    isPrivate: false,
    payMode: "split" as const,
  },
  invite: { waitlistEnabled: true, maxPlayers: 4 },
  participants: [],
  waitlist: [],
  metadata: {
    paymentRef: "pay-1",
    bookingIds: ["booking-1"],
    source: "games_split_widget",
  },
};

test("PAYMENT_PENDING is not mistaken for completed payment", () => {
  assert.equal(isPersistedGamePaymentTerminal(pendingRecord), false);
  assert.equal(isPersistedGamePaymentTerminal({ ...pendingRecord, status: "PAID" }), true);
  assert.equal(isPersistedGamePaymentTerminal({
    ...pendingRecord,
    payment: { ...pendingRecord.payment, paid: true },
  }), true);
  assert.equal(isPersistedGamePaymentTerminal({ ...pendingRecord, status: "CANCELLED" }), false);
  assert.equal(isPersistedGamePaymentTerminal({
    ...pendingRecord,
    status: "CANCELLED",
    payment: { ...pendingRecord.payment, paid: true },
  }), false);
  assert.equal(isPersistedGamePaymentFailedTerminal({ ...pendingRecord, status: "CANCELLED" }), true);
  assert.equal(isPersistedGamePaymentFailedTerminal({ ...pendingRecord, status: "FAILED" }), true);
  assert.equal(isPersistedGamePaymentFailedTerminal({ ...pendingRecord, status: "PAID" }), false);
});

test("callback can rebuild the confirmation draft from a persisted server record", () => {
  const draft = buildPendingPaidGameDraftFromRecord(pendingRecord, "pay-1");
  assert.ok(draft);
  assert.equal(draft.payload.gameId, pendingRecord.id);
  assert.equal(draft.payload.tenantKey, "tenant-1");
  assert.equal(draft.payload.expectedRevision, 7);
  assert.equal(draft.payload.expectedUpdatedAt, pendingRecord.updatedAt);
  assert.equal(draft.payload.status, "PAYMENT_PENDING");
  assert.equal(draft.payload.booking.exerciseId, "exercise-1");
  assert.deepEqual(draft.bookingIds, ["booking-1"]);
  assert.equal(draft.payload.payment.paymentRef, "pay-1");
  assert.equal(draft.payload.metadata?.source, "games_split_widget");
});

test("server fallback refuses an incomplete record", () => {
  assert.equal(buildPendingPaidGameDraftFromRecord({
    ...pendingRecord,
    booking: { ...pendingRecord.booking, roomId: null },
  }, "pay-1"), null);
  assert.equal(buildPendingPaidGameDraftFromRecord({
    ...pendingRecord,
    revision: null,
  }, "pay-1"), null);
  assert.equal(buildPendingPaidGameDraftFromRecord({
    ...pendingRecord,
    tenantKey: null,
  }, "pay-1"), null);
});

test("split create persists and reads back before enqueue and redirect", () => {
  const source = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  const handlerStart = source.indexOf("const handleSplitGamePay = useCallback");
  const handlerEnd = source.indexOf("const handleMasterServicePay = useCallback", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const saveLocal = handler.indexOf("savePendingPaidGameDraft(paymentRef");
  const persistServer = handler.indexOf("await persistServerGameDraftBeforeRedirect(");
  const enqueue = handler.indexOf("enqueuePendingPaymentSync(paymentRef");
  const redirect = handler.indexOf("navigateToExternalUrl(paymentResult.data.paymentUrl)");

  assert.ok(saveLocal >= 0);
  assert.ok(persistServer > saveLocal);
  assert.ok(enqueue > persistServer);
  assert.ok(redirect > enqueue);
  assert.match(handler.slice(persistServer, enqueue), /if \(!persistedDraft\.record\)[\s\S]*return;/);
});

test("payment callback only confirms from a fresh server revision, never a local stale draft", () => {
  const source = fs.readFileSync("src/utils/paymentSync.ts", "utf8");
  const lookup = source.indexOf("const byPaymentRef = await apiFetchPadelGameByPaymentRef");
  const terminalGuard = source.indexOf("isPersistedGamePaymentTerminal(persistedRecord)", lookup);
  const recoveredDraft = source.indexOf("buildPendingPaidGameDraftFromRecord(persistedRecord", lookup);
  const confirm = source.indexOf("await apiConfirmPadelGamePayment", lookup);
  const concurrentReadback = source.indexOf("stage: \"confirm_concurrent_readback\"", confirm);
  const registerFailure = source.indexOf("registerPendingPaymentSyncFailure(paymentRef, errorMessage)", concurrentReadback);

  assert.ok(terminalGuard > lookup);
  assert.ok(recoveredDraft > terminalGuard);
  assert.ok(confirm > recoveredDraft);
  assert.ok(concurrentReadback > confirm);
  assert.ok(registerFailure > concurrentReadback);
  assert.doesNotMatch(source.slice(lookup, confirm), /getPendingPaidGameDraft\(paymentRef\)/);
  assert.doesNotMatch(source, /stage:\s*"legacy_create"/);
});

test("terminal payment failure clears the callback URL instead of retrying forever", () => {
  const source = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  assert.match(source, /if \(failedItem\?\.terminal\) cleanupUrl\(\);/);
});

test("terminal readback is bound to the exact game, paymentRef and booking set", () => {
  const paidRecord = {
    ...pendingRecord,
    status: "PAID",
    payment: { ...pendingRecord.payment, paid: true },
    metadata: {
      ...pendingRecord.metadata,
      paymentRef: "pay-1",
      bookingIds: ["booking-1"],
    },
  };
  assert.equal(isConfirmedPaymentReadbackBound(paidRecord, {
    paymentRef: "pay-1",
    gameId: "game-1",
    bookingIds: ["booking-1"],
  }), true);
  assert.equal(isConfirmedPaymentReadbackBound(paidRecord, {
    paymentRef: "pay-other",
    gameId: "game-1",
    bookingIds: ["booking-1"],
  }), false);
  assert.equal(isConfirmedPaymentReadbackBound(paidRecord, {
    paymentRef: "pay-1",
    gameId: "game-other",
    bookingIds: ["booking-1"],
  }), false);
  assert.equal(isConfirmedPaymentReadbackBound(paidRecord, {
    paymentRef: "pay-1",
    gameId: "game-1",
    bookingIds: ["booking-1", "booking-2"],
  }), false);
});

test("lookup records must carry the exact queued paymentRef", () => {
  assert.equal(isPaymentSyncRecordBoundToPaymentRef(pendingRecord, "pay-1"), true);
  assert.equal(isPaymentSyncRecordBoundToPaymentRef(pendingRecord, "pay-other"), false);
  assert.equal(isPaymentSyncRecordBoundToPaymentRef({
    ...pendingRecord,
    metadata: {
      splitPayment: {
        payments: [{ paymentRef: "pay-split" }],
      },
    },
  }, "pay-split"), true);
});

test("concurrent callback recovery resolves the canonical payload gameId", () => {
  assert.equal(resolvePaymentSyncExpectedGameId(null, "game-from-draft", "game-from-readback"), "game-from-draft");
  assert.equal(resolvePaymentSyncExpectedGameId(undefined, "  ", "game-from-readback"), "game-from-readback");
  assert.equal(resolvePaymentSyncExpectedGameId(undefined, null, ""), null);
});
