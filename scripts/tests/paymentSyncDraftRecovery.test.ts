import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildPendingPaidGameDraftFromRecord,
  isPersistedGamePaymentTerminal,
} from "../../src/utils/paymentSyncDraftRecovery.ts";

const pendingRecord = {
  id: "game-1",
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
  assert.equal(isPersistedGamePaymentTerminal({ ...pendingRecord, status: "CANCELLED" }), true);
});

test("callback can rebuild the confirmation draft from a persisted server record", () => {
  const draft = buildPendingPaidGameDraftFromRecord(pendingRecord, "pay-1");
  assert.ok(draft);
  assert.equal(draft.payload.gameId, pendingRecord.id);
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

test("payment callback only resolves a terminal server record and otherwise uses it as fallback", () => {
  const source = fs.readFileSync("src/utils/paymentSync.ts", "utf8");
  const lookup = source.indexOf("const byPaymentRef = await apiFetchPadelGameByPaymentRef");
  const terminalGuard = source.indexOf("isPersistedGamePaymentTerminal(persistedRecord)", lookup);
  const recoveredDraft = source.indexOf("buildPendingPaidGameDraftFromRecord(persistedRecord", lookup);
  const confirm = source.indexOf("await apiConfirmPadelGamePayment", lookup);

  assert.ok(terminalGuard > lookup);
  assert.ok(recoveredDraft > terminalGuard);
  assert.ok(confirm > recoveredDraft);
});
