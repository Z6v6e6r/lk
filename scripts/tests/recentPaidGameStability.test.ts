import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGameAllRelatedPhones,
  shouldSkipRecentPaidGameBackgroundSync,
  shouldSkipRecentSplitGameRosterSync,
} from "../../src/components/games/recentPaidGameStability.ts";

test("buildGameAllRelatedPhones normalizes and deduplicates organizer, roster and split phones", () => {
  const phones = buildGameAllRelatedPhones({
    organizerPhone: "+7 (910) 430-31-90",
    participants: [
      { id: "p1", name: "Игрок 1", phone: "89104303190", photo: null, rating: null, ratingNumeric: null, source: "ORGANIZER", status: "CONFIRMED" },
      { id: "p2", name: "Игрок 2", phone: "+7 999 111-22-33", photo: null, rating: null, ratingNumeric: null, source: "INVITED", status: "CONFIRMED" },
    ],
    waitlist: [
      { id: "p3", name: "Игрок 3", phone: "79991112233", photo: null, rating: null, ratingNumeric: null, source: "WAITLIST", status: "WAITLIST" },
    ],
    splitPaymentPhones: ["+7 910 430 31 90", "8 (999) 111-22-33"],
  });

  assert.deepEqual(phones, ["79104303190", "79991112233"]);
});

test("shouldSkipRecentPaidGameBackgroundSync skips only fresh flow-created paid records without redirect", () => {
  const nowTs = Date.parse("2026-06-09T12:40:00.000Z");
  const recentPaidRecord = {
    createdByFlow: true,
    createdAt: "2026-06-09T12:39:56.188Z",
    status: "PAID",
    payment: {
      paid: true,
      paymentUrl: null,
    },
  };

  assert.equal(shouldSkipRecentPaidGameBackgroundSync(recentPaidRecord, nowTs), true);
  assert.equal(shouldSkipRecentPaidGameBackgroundSync({
    ...recentPaidRecord,
    payment: {
      paid: true,
      paymentUrl: "https://pay.example.test",
    },
  }, nowTs), false);
  assert.equal(shouldSkipRecentPaidGameBackgroundSync({
    ...recentPaidRecord,
    createdAt: "2026-06-09T12:38:00.000Z",
  }, nowTs), false);
});

test("shouldSkipRecentSplitGameRosterSync only skips immediate split create with stable local roster", () => {
  const recentPaidRecord = {
    createdByFlow: true,
    createdAt: "2026-06-09T12:39:56.188Z",
    status: "PAID",
    payment: {
      paid: true,
      paymentUrl: null,
    },
  };
  const nowTs = Date.parse("2026-06-09T12:40:00.000Z");

  assert.equal(shouldSkipRecentSplitGameRosterSync({
    record: recentPaidRecord,
    isSplitPaymentGame: true,
    sourceParticipantsCount: 1,
    leaveEventsCount: 0,
    nowTs,
  }), true);
  assert.equal(shouldSkipRecentSplitGameRosterSync({
    record: recentPaidRecord,
    isSplitPaymentGame: true,
    sourceParticipantsCount: 0,
    leaveEventsCount: 0,
    nowTs,
  }), false);
  assert.equal(shouldSkipRecentSplitGameRosterSync({
    record: recentPaidRecord,
    isSplitPaymentGame: true,
    sourceParticipantsCount: 1,
    leaveEventsCount: 1,
    nowTs,
  }), false);

  assert.equal(shouldSkipRecentSplitGameRosterSync({
    record: {
      ...recentPaidRecord,
      metadata: {
        lastLeaveUpdateAt: "2026-06-09T12:39:59.000Z",
      },
    },
    isSplitPaymentGame: true,
    sourceParticipantsCount: 1,
    leaveEventsCount: 1,
    nowTs,
  }), true);

  assert.equal(shouldSkipRecentSplitGameRosterSync({
    record: {
      ...recentPaidRecord,
      metadata: {
        lastLeaveUpdateAt: "2026-06-09T12:39:10.000Z",
      },
    },
    isSplitPaymentGame: true,
    sourceParticipantsCount: 1,
    leaveEventsCount: 1,
    nowTs,
  }), false);
});
