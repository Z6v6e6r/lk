import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveSplitPaymentOccupancy } from "../../src/components/games/splitPaymentOccupancy.ts";

const NOW_TS = Date.parse("2026-07-31T19:00:00.000Z");
const participants = [
  { id: "organizer", phone: "79850000001" },
  { id: "player-2", phone: null },
  { id: "player-3", phone: null },
];

test("stale WAITLIST payment rows do not fill free split-game spots", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [
      { clientId: "organizer", phoneNorm: "79850000001", status: "PAID", spot: 1 },
      { clientId: "old-waitlist-2", status: "WAITLIST", spot: 2 },
      { clientId: "old-waitlist-3", status: "WAITLIST", spot: 3 },
      { clientId: "old-waitlist-4", status: "WAITLIST", spot: 4 },
    ],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 0);
});

test("LEFT payment rows do not fill free split-game spots", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [
      { clientId: "organizer", phoneNorm: "79850000001", status: "PAID", spot: 1 },
      { clientId: "former-player", status: "LEFT", spot: 4 },
    ],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 0);
});

test("unexpired PAYMENT_PENDING holds one spot until its deadline", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [{
      clientId: "pending-player",
      status: "PAYMENT_PENDING",
      spot: 4,
      deadlineAt: "2026-07-31T19:10:00.000Z",
    }],
  });

  assert.equal(result.occupiedSlotsCount, 4);
  assert.deepEqual(Array.from(result.reservedPaymentsBySpot.keys()), [3]);
});

test("expired PAYMENT_PENDING releases its spot", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [{
      clientId: "expired-player",
      status: "PAYMENT_PENDING",
      spot: 4,
      deadlineAt: "2026-07-31T18:59:59.000Z",
    }],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 0);
});

test("PAYMENT_PENDING uses both supported split-level participant deadlines", () => {
  for (const deadlineKey of ["participantDeadlineAt", "participantPaymentDeadlineAt"] as const) {
    const splitPayment = {
      [deadlineKey]: "2026-07-31T18:59:59.000Z",
    };
    const result = resolveSplitPaymentOccupancy({
      participants,
      maxPlayers: 4,
      nowTs: NOW_TS,
      splitPayment,
      payments: [{ clientId: `expired-by-${deadlineKey}`, status: "PAYMENT_PENDING", spot: 4 }],
    });

    assert.equal(result.occupiedSlotsCount, 3);
    assert.equal(result.reservedPaymentsBySpot.size, 0);
  }
});

test("PAYMENT_PENDING falls back to createdAt plus ten minutes", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    paymentDeadlineMinutes: 10,
    payments: [{
      clientId: "expired-by-created-at",
      status: "PAYMENT_PENDING",
      spot: 4,
      createdAt: "2026-07-31T18:49:59.000Z",
    }],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 0);
});

test("createdAt cap wins over an excessively long explicit pending deadline", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    paymentDeadlineMinutes: 10,
    payments: [{
      clientId: "capped-by-created-at",
      status: "PAYMENT_PENDING",
      spot: 4,
      createdAt: "2026-07-31T18:49:59.000Z",
      deadlineAt: "2026-08-01T19:00:00.000Z",
    }],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 0);
});

test("confirmed participants keep a full roster full", () => {
  const result = resolveSplitPaymentOccupancy({
    participants: [...participants, { id: "player-4", phone: "79850000004" }],
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [],
  });

  assert.equal(result.occupiedSlotsCount, 4);
});

test("inactive payment statuses never occupy a spot", () => {
  const statuses = [
    "CANCELLED",
    "DECLINED",
    "FAILED",
    "ERROR",
    "EXPIRED",
    "REFUNDED",
    "REJECTED",
    "VOID",
    "CLOSED",
    "ARCHIVED",
  ];
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 20,
    nowTs: NOW_TS,
    payments: statuses.map((status, index) => ({
      clientId: `inactive-${index}`,
      status,
      spot: index + 4,
    })),
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 0);
});

test("paid payment already represented by participant is not counted twice", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [
      { clientId: "organizer", status: "PAID", spot: 1 },
      { phoneNorm: "+7 (985) 000-00-01", status: "CONFIRMED", spot: 2 },
    ],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 0);
});

test("unmatched paid reservation occupies one additional spot", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [{ clientId: "paid-player", status: "PAID", spot: 4 }],
  });

  assert.equal(result.occupiedSlotsCount, 4);
  assert.deepEqual(Array.from(result.reservedPaymentsBySpot.keys()), [3]);
});

test("duplicate payments for the same unmatched client reserve only one spot", () => {
  const result = resolveSplitPaymentOccupancy({
    participants,
    maxPlayers: 5,
    nowTs: NOW_TS,
    payments: [
      { clientId: "paid-player", status: "PAID", spot: 4 },
      { clientId: "paid-player", status: "CONFIRMED", spot: 5 },
    ],
  });

  assert.equal(result.occupiedSlotsCount, 4);
  assert.deepEqual(Array.from(result.reservedPaymentsBySpot.keys()), [3]);
});

test("legacy id plus phone row deduplicates with a phone-only row", () => {
  const result = resolveSplitPaymentOccupancy({
    participants: participants.slice(0, 2),
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [
      { clientId: "legacy-player", phone: "79990000003", status: "PAID", spot: 3 },
      { phoneNorm: "+7 (999) 000-00-03", status: "CONFIRMED", spot: 4 },
    ],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.deepEqual(Array.from(result.reservedPaymentsBySpot.keys()), [2]);
});

test("shared paymentRef deduplicates rows with different identity aliases", () => {
  const result = resolveSplitPaymentOccupancy({
    participants: participants.slice(0, 2),
    maxPlayers: 4,
    nowTs: NOW_TS,
    payments: [
      { clientId: "legacy-player", paymentRef: "same-payment", status: "PAID", spot: 3 },
      { phoneNorm: "79990000004", paymentRef: "same-payment", status: "CONFIRMED", spot: 4 },
    ],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.deepEqual(Array.from(result.reservedPaymentsBySpot.keys()), [2]);
});

test("bridge row merges earlier id-only and phone-only reservation groups", () => {
  const result = resolveSplitPaymentOccupancy({
    participants: participants.slice(0, 2),
    maxPlayers: 5,
    nowTs: NOW_TS,
    payments: [
      { clientId: "bridge-player", status: "PAID", spot: 3 },
      { phoneNorm: "79990000005", status: "PAID", spot: 4 },
      { clientId: "bridge-player", phone: "+7 (999) 000-00-05", status: "CONFIRMED", spot: 5 },
    ],
  });

  assert.equal(result.occupiedSlotsCount, 3);
  assert.equal(result.reservedPaymentsBySpot.size, 1);
});

test("Games details use shared occupancy for the counter and both join CTAs", () => {
  const source = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  const resolverIndex = source.indexOf("const detailsSplitOccupancy = useMemo");
  const occupiedIndex = source.indexOf("return detailsSplitOccupancy.occupiedSlotsCount", resolverIndex);
  const freeSlotsIndex = source.indexOf(
    "const detailsHasFreeSlots = detailsOccupiedSlotsCount < detailsMaxPlayers",
    occupiedIndex,
  );
  const joinGuardIndex = source.indexOf("const canCurrentUserJoinSplitGameInDetails", freeSlotsIndex);
  const waitlistGuardIndex = source.indexOf("&& !isCurrentUserInWaitlist", joinGuardIndex);
  const firstCtaIndex = source.indexOf("disabled={!canCurrentUserJoinSplitGameInDetails}", joinGuardIndex);
  const secondCtaIndex = source.indexOf("disabled={!canCurrentUserJoinSplitGameInDetails}", firstCtaIndex + 1);

  assert.ok(resolverIndex >= 0, "split details must resolve occupancy once");
  assert.ok(occupiedIndex > resolverIndex, "details counter must use resolved occupancy");
  assert.ok(
    source.includes("if (!isDetailsSplitPaymentGame) {\n      return Math.min(detailsParticipants.length, detailsMaxPlayers);"),
    "non-split occupancy must keep using the participant roster only",
  );
  assert.ok(freeSlotsIndex > occupiedIndex, "free-slot guard must use the same count");
  assert.ok(joinGuardIndex > freeSlotsIndex, "join guard must depend on corrected free-slot state");
  assert.ok(
    waitlistGuardIndex > joinGuardIndex && waitlistGuardIndex < firstCtaIndex,
    "current waitlisted user must not start a duplicate payment",
  );
  assert.ok(firstCtaIndex > joinGuardIndex, "subscription CTA must use corrected join guard");
  assert.ok(secondCtaIndex > firstCtaIndex, "one-time CTA must use corrected join guard");
  assert.match(
    source,
    /const inactiveMarkers = \[[\s\S]*?"LEFT",[\s\S]*?\];/,
    "LEFT payments must be inactive for details payment checks too",
  );
  assert.match(source, /const nextWaitlist = excludePlayersAlreadyInRoster\(detailsWaitlist, mergedParticipants\)/);
  assert.match(source, /waitlistChanged = !arePlayersEqualByIdentity\(nextWaitlist, detailsWaitlist\)/);
  assert.match(source, /waitlistChanged \? \{ waitlist: nextWaitlist \} : \{\}/);
  assert.equal(
    source.includes("Math.max(detailsParticipants.length, detailsSplitReservedPlayersBySpot.size)"),
    false,
    "legacy spot-map max must not drive occupancy",
  );
});

test("both public game_join entry paths open the same GamesPage details flow", () => {
  const gamesEntrySource = fs.readFileSync("src/games.tsx", "utf8");
  const appSource = fs.readFileSync("src/MyApp.tsx", "utf8");
  assert.ok(
    gamesEntrySource.includes('data?.openGameId || data?.joinGameId'),
    "standalone games bundle must resolve the join game id",
  );
  assert.ok(
    gamesEntrySource.includes("openGameId={openGameId}"),
    "standalone games bundle must open GamesPage details by id",
  );
  const routeIndex = appSource.indexOf("if (joinRouteData.enabled)");
  const gamesPageIndex = appSource.indexOf("<GamesPage", routeIndex);
  const openGameIndex = appSource.indexOf("openGameId={joinRouteData.gameId}", gamesPageIndex);
  assert.ok(routeIndex >= 0, "main bundle must detect public game_join route");
  assert.ok(gamesPageIndex > routeIndex, "main bundle game_join route must render GamesPage");
  assert.ok(openGameIndex > gamesPageIndex, "main bundle must pass join game id to GamesPage details");
});
