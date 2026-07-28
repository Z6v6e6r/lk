import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildSyntheticCabinetGameFromBooking,
  CABINET_BOOKING_SYNTHETIC_SOURCE,
  isSyntheticCabinetBookingGame,
} from "../../src/components/cabinet/syntheticBookingGame.ts";
import type { Booking, PadelGamePlayer } from "../../src/utils/apiClient.ts";

test("buildSyntheticCabinetGameFromBooking creates a synthetic Viva game record", () => {
  const currentUserPlayer: PadelGamePlayer = {
    id: "client-1",
    name: "Elena Player",
    phone: "79990001122",
    photo: null,
    rating: null,
    ratingNumeric: null,
    source: "MANUAL_PHONE",
    status: "CONFIRMED",
  };
  const booking: Booking = {
    id: "booking-1",
    spot: 1,
    paymentType: "SUBSCRIPTION",
    isCancelled: false,
    visitConfirmed: true,
    cost: 350000,
    cancellationDeadline: "2026-06-08T08:30:00+03:00",
    transactionStatus: {
      transactionId: "tx-1",
      transactionStatus: "PAID",
      cardPaymentStatus: {
        paymentId: "pay-1",
        paymentUrl: "https://example.com/pay",
        status: "PAID",
        originalStatus: "PAID",
      },
    },
    exercise: {
      id: "122453f6-a342-4d09-9d10-f94eb2614c63",
      direction: { id: 4588, name: "Открытая игра на 4-ых человек." },
      type: { id: 1613, name: "Открытая игра", color: "#000000", format: "group" },
      timeFrom: "2026-06-08T10:30:00+03:00",
      timeTo: "2026-06-08T12:30:00+03:00",
      clientsCount: 2,
      maxClientsCount: 4,
      girlsOnly: false,
      studio: {
        id: "0d5504f6-ea6f-44bb-a9e4-947faf0273ab",
        name: "Сколково",
        address: "г Москва, Сколковское шоссе, д 33",
      },
      room: {
        id: "78337690-6f46-43d0-ae57-f2e295d3b903",
        name: "Корт №3 панорамик",
      },
      trainers: [],
    },
  };

  const game = buildSyntheticCabinetGameFromBooking(booking, {
    paid: true,
    currentUserPlayer,
  });

  assert.ok(game);
  assert.equal(game.id, "viva_122453f6-a342-4d09-9d10-f94eb2614c63");
  assert.equal(game.metadata?.source, CABINET_BOOKING_SYNTHETIC_SOURCE);
  assert.equal(game.booking?.exerciseId, booking.exercise?.id);
  assert.equal(game.booking?.timeFrom, "10:30");
  assert.equal(game.booking?.timeTo, "12:30");
  assert.equal(game.invite?.maxPlayers, 4);
  assert.equal(game.payment?.amount, 3500);
  assert.equal(game.payment?.paid, true);
  assert.equal(game.participants?.[0]?.id, "client-1");
  assert.equal(isSyntheticCabinetBookingGame(game), true);
});

test("synthetic booking game wiring is passed through overlay entrypoints", () => {
  const myAppSource = fs.readFileSync("src/MyApp.tsx", "utf8");
  const gamesEntrySource = fs.readFileSync("src/games.tsx", "utf8");
  const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

  assert.ok(myAppSource.includes("!options?.initialGameRecord"));
  assert.ok(myAppSource.includes("initialGameRecord: options?.initialGameRecord ?? null"));
  assert.ok(gamesEntrySource.includes("initialGameRecord={data?.initialGameRecord ?? null}"));
  assert.ok(gamesPageSource.includes("const isReadOnlySyntheticGame = useMemo("));
});
