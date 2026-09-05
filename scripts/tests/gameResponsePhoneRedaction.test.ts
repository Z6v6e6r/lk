import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

type JsonRecord = Record<string, unknown>;

const PHONE = "79991112233";
const FORMATTED_PHONE = `+${PHONE[0]} (${PHONE.slice(1, 4)}) ${PHONE.slice(4, 7)}-${PHONE.slice(7, 9)}-${PHONE.slice(9, 11)}`;
const PHONE_KEY = /(?:^|[^a-z0-9])(?:phones?|mobiles?|telephones?|msisdn)(?:[^a-z0-9]|$)/i;

function isPhoneKey(key: string) {
  return PHONE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

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
      assert.equal(isPhoneKey(key), false, `${path}.${key} is a phone-bearing field`);
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
    allowedPhoneNorms: [PHONE],
    [`phone:${PHONE}`]: "legacy-identity-index",
    metadata: {
      phoneNorm: null,
      organizerPhone: PHONE,
      safeClientId: "client-organizer",
      callbackUrl: `https://example.test/game?phone=${PHONE}&gameId=game-public-1`,
      publicNote: `Связь: ${FORMATTED_PHONE} после игры`,
      microphoneEnabled: true,
      smartphoneTheme: "dark",
      phonebookEntryId: "directory-entry-1",
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

function crossRealmGameFixture(): JsonRecord {
  return vm.runInNewContext(`({
    id: "game-cross-realm",
    status: "ACTIVE",
    createdAt: new Date("2026-08-27T09:00:00.000Z"),
    booking: {
      id: "booking-cross-realm",
      startTs: Date.now() + 3_600_000,
      endTs: Date.now() + 7_200_000,
    },
    organizer: { id: "client-cross-realm", phone, phoneNorm: phone },
    participants: [{ id: "client-cross-realm", phone, status: "CONFIRMED" }],
    metadata: {
      safeClientId: "client-cross-realm",
      nested: { callbackUrl: "https://example.test/game?phone=" + phone },
    },
  })`, { phone: PHONE }) as JsonRecord;
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
  assert.equal(asRecord(games[0]?.metadata).smartphoneTheme, "dark");
  assert.equal(asRecord(games[0]?.metadata).phonebookEntryId, "directory-entry-1");
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

test("list and direct lookup redact Mongo-like records from another VM realm", () => {
  const listGame = crossRealmGameFixture();
  const listOriginal = JSON.stringify(listGame);
  const listOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_list_normalize.js", {
    _lkIncludePast: true,
    _lkOffset: 0,
    _lkPublicMode: true,
    payload: [listGame],
  }) as unknown[];
  const listPayload = asRecord(asRecord(listOut[0]).payload);
  const listedGame = asRecord((listPayload.games as JsonRecord[])[0]);

  assert.equal(listedGame.id, "game-cross-realm");
  assert.equal(Object.prototype.toString.call(listedGame.createdAt), "[object Date]");
  assert.equal((listedGame.createdAt as Date).toISOString(), "2026-08-27T09:00:00.000Z");
  assertPhoneFree(listPayload);
  assert.equal(JSON.stringify(listGame), listOriginal, "cross-realm list sanitization must not mutate the stored document");

  const directGame = crossRealmGameFixture();
  const directOriginal = JSON.stringify(directGame);
  const directOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_get_by_id_resp.js", {
    payload: [directGame],
  }) as unknown[];
  const directPayload = asRecord(asRecord(directOut[0]).payload);

  assert.equal(directPayload.id, "game-cross-realm");
  assert.equal(Object.prototype.toString.call(directPayload.createdAt), "[object Date]");
  assert.equal((directPayload.createdAt as Date).toISOString(), "2026-08-27T09:00:00.000Z");
  assertPhoneFree(directPayload);
  assert.equal(JSON.stringify(directGame), directOriginal, "cross-realm direct sanitization must not mutate the stored document");
});

test("direct lookup keeps the existing 404 contract", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_get_by_id_resp.js", {
    payload: [],
  }) as unknown[];
  const response = asRecord(out[0]);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.payload, { error: "Game not found" });
});

const UUID = "d212d860-4924-4450-b520-bdb5612c46cd";
const GAME_ID = `pay_${UUID}`;

for (const mode of ["public list", "identity list", "direct lookup"] as const) {
  function readGame(game: JsonRecord) {
    const direct = mode === "direct lookup";
    const out = runNodeRedFunction(
      `scripts/nodered_games_nodes/${direct ? "fn_get_by_id_resp" : "fn_list_normalize"}.js`,
      {
        _lkPhone: mode === "identity list" ? PHONE : null,
        _lkClientId: mode === "identity list" ? "client-organizer" : null,
        _lkIncludePast: true,
        _lkOffset: 0,
        _lkPublicMode: mode === "public list",
        payload: [game],
      },
    ) as unknown[];
    const payload = asRecord(asRecord(out[0]).payload);
    return direct ? payload : asRecord((payload.games as JsonRecord[])[0]);
  }

  test(`${mode}: preserves UUIDs and the list-to-invitation-to-lookup game ID`, () => {
    const game = gameFixture();
    game.id = GAME_ID;
    const metadata = asRecord(game.metadata);
    metadata.exerciseId = UUID;
    metadata.references = [UUID, GAME_ID, UUID.toUpperCase()];
    metadata.inviteUrl = `https://example.test/game_join?joinGame=${GAME_ID}&phone=${PHONE}`;
    metadata.publicNote = `Игра ${GAME_ID}; связь ${FORMATTED_PHONE}; запись ${UUID}`;
    const original = structuredClone(game);

    const result = readGame(game);
    assert.equal(result.id, GAME_ID);
    const safeMetadata = asRecord(result.metadata);
    assert.equal(safeMetadata.exerciseId, UUID);
    assert.deepEqual(safeMetadata.references, metadata.references);
    assert.equal(safeMetadata.inviteUrl, `https://example.test/game_join?joinGame=${GAME_ID}&phone=[redacted]`);
    assert.equal(safeMetadata.publicNote, `Игра ${GAME_ID}; связь [redacted]; запись ${UUID}`);
    const invite = new URL("https://example.test/game_join");
    invite.searchParams.set("joinGame", String(result.id));
    const queryOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_get_by_id_query.js", {
      req: { params: { gameId: invite.searchParams.get("joinGame") }, query: {} },
    }) as unknown[];
    assert.deepEqual(asRecord(queryOut[0]).payload, { id: GAME_ID, archived: { $ne: true } });
    assertPhoneFree(result);
    assert.deepEqual(game, original);
  });

  test(`${mode}: UUID protection does not exempt phone fields, identities or adjacent phones`, () => {
    const game = gameFixture();
    const metadata = asRecord(game.metadata);
    metadata.phone = UUID;
    metadata.phoneIdentity = `phone:${UUID}`;
    metadata.identity = `phone:${UUID}`;
    metadata.callbackUrl = `https://example.test/?phone=${UUID}&ref=${UUID}`;
    metadata.nearIds = `${PHONE}/${UUID}/${FORMATTED_PHONE}/${GAME_ID}/${PHONE}`;
    metadata.id = PHONE;
    metadata.bookingId = FORMATTED_PHONE;
    metadata.almostUuid = "d212d860-4924-4450-b520-bdb5612c46cg";

    const result = readGame(game);
    const safeMetadata = asRecord(result.metadata);
    assert.equal("identity" in safeMetadata, false);
    assert.equal("id" in safeMetadata, false);
    assert.equal("bookingId" in safeMetadata, false);
    assert.equal(safeMetadata.callbackUrl, `https://example.test/?phone=[redacted]&ref=${UUID}`);
    assert.equal(safeMetadata.nearIds, `[redacted]/${UUID}/[redacted]/${GAME_ID}/[redacted]`);
    assert.equal(safeMetadata.almostUuid, "d212d[redacted]-b520-bdb5612c46cg");
    assertPhoneFree(result);
  });
}
