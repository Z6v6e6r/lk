import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type JsonRecord = Record<string, unknown>;

const PHONE = "79991112233";
const FORMATTED_PHONE = `+${PHONE[0]} (${PHONE.slice(1, 4)}) ${PHONE.slice(4, 7)}-${PHONE.slice(7, 9)}-${PHONE.slice(9, 11)}`;
const PHONE_KEY = /(?:^|[_-])(?:phone|mobile|telephone|msisdn)(?:s|number|norm|normalized)?(?:$|[_-])|(?:Phone|Mobile|Telephone|Msisdn)(?:s|Number|Norm|Normalized)?$/;

function runNodeRedFunction(file: string, msg: JsonRecord) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", "global", source)(msg, { get() {}, set() {} });
}

function asRecord(value: unknown): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonRecord;
}

function assertPhoneFree(value: unknown, path = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPhoneFree(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      assert.doesNotMatch(key, PHONE_KEY, `${path}.${key} is a phone-bearing field`);
      assertPhoneFree(item, `${path}.${key}`);
    });
    return;
  }
  if (typeof value === "string") {
    assert.equal(value.includes(PHONE), false, `${path} contains a raw phone`);
    assert.equal(value.includes(FORMATTED_PHONE), false, `${path} contains a formatted phone`);
    assert.doesNotMatch(value, /^(phone|mobile|telephone|msisdn):/i, `${path} contains a phone identity`);
  }
  if (typeof value === "number") {
    assert.notEqual(value, Number(PHONE), `${path} contains a numeric phone`);
  }
}

function gameFixture(): JsonRecord {
  return {
    id: "game-public-1",
    status: "ACTIVE",
    revision: 7,
    createdAt: new Date("2026-08-27T09:00:00.000Z"),
    booking: {
      id: "booking-1",
      date: "2026-08-28",
      startTs: Date.now() + 3_600_000,
      endTs: Date.now() + 7_200_000,
    },
    organizer: {
      id: "client-organizer",
      name: "Организатор",
      phone: PHONE,
      phoneNorm: PHONE,
    },
    participants: [
      {
        id: "client-organizer",
        name: "Организатор",
        phone: PHONE,
        memberKey: `phone:${PHONE}`,
        status: "CONFIRMED",
      },
    ],
    waitlist: [{ id: "client-waitlist", name: "Участник", mobile: PHONE }],
    participantPhones: [PHONE],
    allRelatedPhones: [PHONE],
    metadata: {
      organizerPhone: PHONE,
      safeClientId: "client-organizer",
      callbackUrl: `https://example.test/game?phone=${PHONE}&gameId=game-public-1`,
      publicNote: `Связь: ${FORMATTED_PHONE} после игры`,
      microphoneEnabled: true,
      numericReference: Number(PHONE),
      splitPayment: {
        payments: [{ clientId: "client-organizer", clientPhoneNorm: PHONE, status: "PAID" }],
      },
      matchResult: {
        photos: [{ url: "https://cdn.example.test/photo.jpg", base64: "heavy-data" }],
      },
    },
  };
}

test("games list filters by private identity before emitting a phone-free response", () => {
  const game = gameFixture();
  const original = structuredClone(game);
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_list_normalize.js", {
    _lkPhone: PHONE,
    _lkClientId: "client-organizer",
    _lkIncludePast: true,
    _lkOffset: 0,
    _lkPublicMode: false,
    payload: [game],
  }) as unknown[];

  const response = asRecord(out[0]);
  const payload = asRecord(response.payload);
  const games = payload.games as JsonRecord[];

  assert.equal(payload.identityFiltered, true);
  assert.equal(payload.total, 1);
  assert.equal(games[0]?.id, "game-public-1");
  assert.equal(asRecord(games[0]?.organizer).id, "client-organizer");
  assert.equal(asRecord(games[0]?.booking).id, "booking-1");
  assert.equal(asRecord(games[0]?.metadata).safeClientId, "client-organizer");
  assert.equal(asRecord(games[0]?.metadata).microphoneEnabled, true);
  assert.ok(games[0]?.createdAt instanceof Date);
  assert.equal((games[0]?.createdAt as Date).toISOString(), "2026-08-27T09:00:00.000Z");
  const photos = asRecord(asRecord(games[0]?.metadata).matchResult).photos as JsonRecord[];
  assert.equal(photos[0]?.url, "https://cdn.example.test/photo.jpg");
  assert.equal("base64" in photos[0], false);
  assertPhoneFree(payload);
  assert.deepEqual(game, original, "response sanitization must not mutate the stored document");
});

test("public list is phone-free without claiming identity filtering", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_list_normalize.js", {
    _lkPhone: null,
    _lkClientId: null,
    _lkIncludePast: true,
    _lkOffset: 0,
    _lkPublicMode: true,
    payload: [gameFixture()],
  }) as unknown[];
  const payload = asRecord(asRecord(out[0]).payload);

  assert.equal(payload.identityFiltered, false);
  assert.equal((payload.games as JsonRecord[])[0]?.id, "game-public-1");
  assertPhoneFree(payload);
});

test("direct game lookup emits the latest matching document without phone data", () => {
  const older = { ...gameFixture(), revision: 6, updatedAt: "2026-08-26T10:00:00.000Z" };
  const latest = { ...gameFixture(), revision: 8, updatedAt: "2026-08-27T10:00:00.000Z" };
  const latestOriginal = structuredClone(latest);
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_get_by_id_resp.js", {
    payload: [older, latest],
  }) as unknown[];

  const response = asRecord(out[0]);
  const payload = asRecord(response.payload);
  assert.equal(payload.revision, 8);
  assert.equal(payload.id, "game-public-1");
  assertPhoneFree(payload);
  assert.deepEqual(latest, latestOriginal, "direct lookup must not mutate the stored document");
});

test("direct lookup keeps the existing 404 contract", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_get_by_id_resp.js", {
    payload: [],
  }) as unknown[];
  const response = asRecord(out[0]);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.payload, { error: "Game not found" });
});
