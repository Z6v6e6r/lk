import test from "node:test";
import assert from "node:assert/strict";
import {
  getTournamentJsonFileName,
  parseTournamentJson,
  serializeTournamentJson,
} from "../../src/utils/tournamentJson.ts";

test("tournament JSON serializes and parses envelope payloads", () => {
  const payload = {
    tournamentId: "t-1",
    tenantKey: "tenant-1",
    createdAt: "2026-06-06T11:00:00.000Z",
    organizer: {
      id: "org-1",
      phone: null,
      tenantKey: "tenant-1",
    },
    tournamentType: "americano_padelhub",
    targetScore: 21,
    courts: ["Корт 1"],
    participants: [
      {
        id: "p-1",
        phone: null,
        rating: "4.5",
        photo: null,
        name: "Игрок 1",
      },
    ],
    rounds: [
      {
        id: "round-1",
        index: 1,
        matches: [
          {
            id: "match-1",
            court: "Корт 1",
            pair1: ["p-1"],
            pair2: [],
            score1: 6,
            score2: 4,
          },
        ],
      },
    ],
  } as const;

  const json = serializeTournamentJson(payload);
  const parsedEnvelope = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsedEnvelope.kind, "tournament");
  assert.equal(parsedEnvelope.version, 1);

  const parsedPayload = parseTournamentJson(json);
  assert.deepEqual(parsedPayload, payload);
  assert.equal(
    getTournamentJsonFileName(payload),
    "tournament-t-1-2026-06-06.json",
  );
});

test("tournament JSON parser accepts raw payloads", () => {
  const raw = {
    tournamentId: "t-raw",
    tenantKey: "tenant-raw",
    createdAt: "2026-06-06T00:00:00.000Z",
    organizer: {
      id: null,
      phone: null,
      tenantKey: "tenant-raw",
    },
    tournamentType: "mexicano",
    targetScore: 15,
    courts: ["Корт 1"],
    participants: [],
  };

  assert.deepEqual(parseTournamentJson(JSON.stringify(raw)), raw);
});
