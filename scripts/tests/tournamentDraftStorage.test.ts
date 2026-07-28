import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTournamentDraft,
  readCachedTournamentDraftsFromStorage,
  serializeTournamentDraft,
} from "../../src/utils/tournamentDraftStorage.ts";

test("tournament draft serializes and parses envelope snapshots", () => {
  const snapshot = {
    payload: {
      tournamentId: "t-1",
      tenantKey: "tenant-1",
      createdAt: "2026-06-06T11:00:00.000Z",
      organizer: {
        id: "org-1",
        phone: "+79990000001",
        tenantKey: "tenant-1",
      },
      tournamentType: "americano_padelhub",
      targetScore: 21,
      courts: ["Корт 1"],
      participants: [
        {
          id: "p-1",
          phone: "+79990000002",
          rating: "4.5",
          photo: null,
          name: "Игрок 1",
        },
      ],
      params: {
        status: "draft",
      },
      rounds: [
        {
          id: "round-1",
          index: 1,
          matches: [],
        },
      ],
    },
    totals: {
      wins: 1,
    },
    playerLogs: {
      "p-1": [
        {
          roundId: "round-1",
          matchId: "match-1",
          scoreFor: 6,
          scoreAgainst: 4,
          delta: 0.25,
          ratingBefore: 4.5,
          ratingAfter: 4.75,
          expected: 0.5,
          actual: 1,
        },
      ],
    },
    updatedAt: "2026-06-06T12:00:00.000Z",
  } as const;

  const serialized = serializeTournamentDraft(snapshot);
  const parsedEnvelope = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(parsedEnvelope.kind, "tournament-draft");
  assert.equal(parsedEnvelope.version, 1);

  const parsed = parseTournamentDraft(serialized);
  assert.deepEqual(parsed, snapshot);
});

test("tournament draft storage scan returns only cached drafts sorted by recency", () => {
  const storage = {
    length: 3,
    key(index: number) {
      return [
        "tournaments:draft:t-older",
        "ignored:key",
        "tournaments:draft:t-newer",
      ][index] ?? null;
    },
    getItem(key: string) {
      if (key === "tournaments:draft:t-older") {
        return JSON.stringify({
          version: 1,
          kind: "tournament-draft",
          tournamentId: "t-older",
          updatedAt: "2026-06-06T10:00:00.000Z",
          payload: {
            tournamentId: "t-older",
            tenantKey: "tenant-1",
            createdAt: "2026-06-06T09:00:00.000Z",
            organizer: {
              id: null,
              phone: null,
              tenantKey: "tenant-1",
            },
            tournamentType: "americano_padelhub",
            targetScore: 21,
            courts: ["Корт 1"],
            participants: [],
            rounds: [],
          },
          totals: null,
          playerLogs: null,
        });
      }
      if (key === "tournaments:draft:t-newer") {
        return JSON.stringify({
          version: 1,
          kind: "tournament-draft",
          tournamentId: "t-newer",
          updatedAt: "2026-06-06T11:00:00.000Z",
          payload: {
            tournamentId: "t-newer",
            tenantKey: "tenant-1",
            createdAt: "2026-06-06T10:30:00.000Z",
            organizer: {
              id: null,
              phone: null,
              tenantKey: "tenant-1",
            },
            tournamentType: "mexicano",
            targetScore: 21,
            courts: ["Корт 1"],
            participants: [],
            rounds: [],
          },
          totals: null,
          playerLogs: null,
        });
      }
      return null;
    },
  };

  const drafts = readCachedTournamentDraftsFromStorage(storage);
  assert.deepEqual(drafts.map((draft) => draft.payload.tournamentId), ["t-newer", "t-older"]);
});

test("tournament draft parser accepts raw payloads", () => {
  const payload = {
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
    rounds: [],
  } as const;

  const parsed = parseTournamentDraft(JSON.stringify(payload));
  assert.ok(parsed);
  assert.equal(parsed?.updatedAt.length > 0, true);
  assert.deepEqual(parsed?.payload, payload);
});
