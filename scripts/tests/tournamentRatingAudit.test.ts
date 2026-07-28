import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  buildTournamentRatingChangePayload,
  buildTournamentStartRatingChanges,
} from "../../src/components/tournaments/tournamentRatingAudit.ts";

test("tournament rating change records player, before/after values and actor", () => {
  const payload = buildTournamentRatingChangePayload({
    tournamentId: "tournament-42",
    clientId: "client-7",
    playerName: "Дмитрий Тестов",
    playerPhone: "+7 919 729-52-79",
    previousRating: 2.15778,
    nextRating: 3.59638,
    levelLetter: "C+",
    changedAt: "2026-07-20T12:34:56.000Z",
    changedBy: {
      id: "admin-3",
      firstName: "Анна",
      lastName: "Организатор",
      phone: "+7 900 000-00-03",
    },
  });

  assert.deepEqual(payload, {
    clientId: "client-7",
    phone: "+7 919 729-52-79",
    levelLetter: "C+",
    levelNumeric: 3.59638,
    source: "tournament_start",
    gameId: "tournament-42",
    playerName: "Дмитрий Тестов",
    previousRating: 2.15778,
    nextRating: 3.59638,
    confirmedAt: "2026-07-20T12:34:56.000Z",
    changedById: "admin-3",
    changedByName: "Анна Организатор",
    changedByPhone: "+7 900 000-00-03",
    eventId: "rating_evt:tournament_start:tournament-42:client-7:1784550896000",
  });
});

test("tournament rating change keeps an explicit null previous value", () => {
  const payload = buildTournamentRatingChangePayload({
    tournamentId: "tournament-43",
    clientId: "client-8",
    playerName: "Игрок без уровня",
    previousRating: null,
    nextRating: 1,
    levelLetter: "D",
    changedAt: "2026-07-20T13:00:00.000Z",
    changedBy: {
      id: "admin-3",
      firstName: "Анна",
      lastName: "Организатор",
      phone: "",
    },
  });

  assert.equal(payload.previousRating, null);
  assert.equal(payload.nextRating, 1);
  assert.equal(payload.changedByPhone, null);
});

test("tournament start records only ratings that changed", () => {
  const changes = buildTournamentStartRatingChanges({
    tournamentId: "tournament-42",
    changedAt: "2026-07-20T12:34:56.000Z",
    changedBy: {
      id: "admin-3",
      firstName: "Анна",
      lastName: "Организатор",
      phone: "+7 900 000-00-03",
    },
    participants: [
      {
        participantId: "client-7",
        clientId: "client-7",
        name: "Дмитрий Тестов",
        phone: "+7 919 729-52-79",
        previousRating: 2.15778,
        nextRating: 3.59638,
        reason: "MANUAL_OVERRIDE",
      },
      {
        participantId: "client-8",
        clientId: "client-8",
        name: "Без изменения",
        phone: null,
        previousRating: 3,
        nextRating: 3,
        reason: "MANUAL_OVERRIDE",
      },
      {
        participantId: "client-9",
        clientId: "client-9",
        name: "Без уровня",
        phone: null,
        previousRating: null,
        nextRating: 1,
        reason: "MINIMUM_ASSIGNED",
      },
    ],
  });

  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map((entry) => ({
    player: entry.player.name,
    before: entry.change.before,
    after: entry.change.after,
    reason: entry.source.reason,
    changedBy: entry.changedBy.name,
  })), [
    {
      player: "Дмитрий Тестов",
      before: 2.15778,
      after: 3.59638,
      reason: "MANUAL_OVERRIDE",
      changedBy: "Анна Организатор",
    },
    {
      player: "Без уровня",
      before: null,
      after: 1,
      reason: "MINIMUM_ASSIGNED",
      changedBy: "Анна Организатор",
    },
  ]);
});

test("Node-RED persists sanitized start rating changes in the tournament upsert", () => {
  const source = fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_prepare.js", "utf8");
  const script = new vm.Script(`(function (msg) {\n${source}\n})`);
  const run = script.runInNewContext() as (msg: Record<string, unknown>) => Record<string, unknown>;
  const outputs = run({
    payload: {
      tournamentId: "tournament-42",
      createdAt: "2026-07-20T12:34:56.000Z",
      organizer: { id: "admin-3", name: "Анна Организатор", phone: "+79000000003" },
      startRatingChanges: [{
        eventId: "rating-event-1",
        source: { reason: "MANUAL_OVERRIDE" },
        player: { participantId: "client-7", clientId: "client-7", name: "Дмитрий Тестов" },
        change: { before: 2.15778, after: 3.59638 },
        changedBy: { id: "spoofed-user" },
      }],
    },
  }) as Array<Record<string, unknown> | null>;
  const result = outputs[0] as Record<string, unknown>;
  const update = result.payload as { $set: { startRatingChanges: Array<Record<string, unknown>> } };
  const event = update.$set.startRatingChanges[0] as {
    change: { before: number; after: number };
    changedBy: { id: string; name: string };
  };

  assert.equal(event.change.before, 2.15778);
  assert.equal(event.change.after, 3.59638);
  assert.equal(event.changedBy.id, "admin-3");
  assert.equal(event.changedBy.name, "Анна Организатор");
});
