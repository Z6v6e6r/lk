import test from "node:test";
import assert from "node:assert/strict";
import type { AmericanoTournamentPayload } from "../../src/utils/apiClient.ts";
import { createServerPhonePrivacy } from "../lib/publicPhonePrivacy.mjs";
import crypto from "node:crypto";
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

test("cached phone identities never enter a JSON file and all tournament references stay connected", () => {
  const phone = "70000000001";
  const payload = {
    tournamentId: "cached-tournament", tenantKey: "synthetic-tenant", createdAt: "2026-06-06T00:00:00Z",
    tournamentType: "mexicano", targetScore: 21, courts: ["Корт"],
    organizer: { id: "organizer", phone, tenantKey: "synthetic-tenant" },
    participants: [{ id: phone, phone, name: "Первый", rating: "4", photo: null }],
    rounds: [{ id: "r1", index: 1, byes: [phone], matches: [{ id: "m1", court: "Корт", pair1: [phone], pair2: [], score1: 12, score2: 9 }] }],
    params: { pairAssignments: [[phone]], readyParticipantIds: [phone] },
    totals: { [phone]: { points: 12 } }, playerLogs: { [phone]: [{ scoreFor: 12 }] },
  } as AmericanoTournamentPayload;
  const json = serializeTournamentJson(payload);
  assert.equal(json.includes(phone), false);
  assert.doesNotMatch(json, /"phone"/);
  const safe = JSON.parse(json).payload;
  const id = safe.participants[0].id;
  assert.match(id, /^manual-participant-public-/);
  assert.equal(safe.rounds[0].matches[0].pair1[0], id);
  assert.equal(safe.rounds[0].byes[0], id);
  assert.equal(safe.params.pairAssignments[0][0], id);
  assert.equal(safe.totals[id].points, 12);
  assert.equal(safe.playerLogs[id][0].scoreFor, 12);
  assert.equal(parseTournamentJson(json)?.participants[0].name, "Первый");
  assert.equal(parseTournamentJson(json)?.rounds?.[0].matches[0].score1, 12);
  assert.equal(payload.participants[0].id, phone, "export does not mutate the local source");
  const server = createServerPhonePrivacy(crypto, "synthetic-test-key-not-production-identity-key");
  assert.throws(() => server.restore(safe, payload, "tournament:synthetic-tenant:cached-tournament"), /PUBLIC_IDENTITY_UNKNOWN/);
});

test("JSON export keeps server-issued opaque identities usable for resave", () => {
  const id = "pp_" + "a".repeat(32);
  const payload = { tournamentId: "safe-tournament", tenantKey: "tenant", tournamentType: "mexicano",
    participants: [{ id, name: "Игрок" }], rounds: [{ matches: [{ pair1: [id], pair2: [] }] }],
    params: { readyParticipantIds: [id] } } as unknown as AmericanoTournamentPayload;
  const safe = JSON.parse(serializeTournamentJson(payload)).payload;
  assert.equal(safe.participants[0].id, id);
  assert.equal(safe.rounds[0].matches[0].pair1[0], id);
  assert.equal(safe.params.readyParticipantIds[0], id);
});
