import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import vm from "node:vm";
import fs from "node:fs";
import { ObjectId } from "mongodb";
import { isConfirmedPaymentReadbackBound } from "../../src/utils/paymentSyncDraftRecovery.ts";
import { createServerPhonePrivacy, responsePrivacySource, tournamentRestorePrivacySource, tournamentExportPrivacySource, communityRestorePrivacySource, resultRestorePrivacySource } from "../lib/publicPhonePrivacy.mjs";

const KEY = "synthetic-test-key-not-production-identity-key";
const PHONE = "70000000001";
const OTHER_PHONE = "70000000002";
const privacy = createServerPhonePrivacy(crypto, KEY);
const scope = "tournament:synthetic-tenant:synthetic-tournament";
const tournament = () => ({
  tournamentId: "synthetic-tournament", tenantKey: "synthetic-tenant", tournamentType: "mexicano",
  organizer: { id: "organizer-id", phone: PHONE, name: "Организатор" },
  participants: [{ id: PHONE, phone: PHONE, name: "Первый", rating: "4" }, { id: OTHER_PHONE, phone: OTHER_PHONE, name: "Второй", rating: "4" }],
  rounds: [{ id: "round-1", matches: [{ id: "match-1", pair1: [PHONE], pair2: [OTHER_PHONE], score1: 12, score2: 9 }], byes: [PHONE] }],
  totals: { [PHONE]: { points: 12 }, [OTHER_PHONE]: { points: 9 } },
  playerLogs: { [PHONE]: [{ roundId: "round-1", scoreFor: 12, scoreAgainst: 9 }], [OTHER_PHONE]: [] },
  standings: [{ id: PHONE, name: "Первый", totalPoints: 12 }],
  params: { pairAssignments: [[PHONE, OTHER_PHONE]], readyParticipantIds: [PHONE], participantReadyIds: { [PHONE]: true } },
});
function phoneFree(value) {
  const json = JSON.stringify(value);
  assert.equal(json.includes(PHONE), false, "first synthetic phone reached the client");
  assert.equal(json.includes(OTHER_PHONE), false, "second synthetic phone reached the client");
  assert.doesNotMatch(json, /"(?:phone|phoneNorm|authorPhone|playerPhone|relatedPhones)"/);
}
function run(source, msg, key = KEY) {
  return vm.runInNewContext(`(function(msg) { ${source}\n })(msg)`, { msg, crypto, Buffer, env: { get: () => key } }, { timeout: 2000 });
}

test("anonymous community roster remains readable with identical names, roles and levels", () => {
  const original = { communities: [{ id: "community", name: "Клуб", visibility: "OPEN", members: [
    { id: "real-user-id", name: "Игрок", role: "MEMBER", levelScore: 4, phone: PHONE },
    { id: null, name: "Игрок", role: "OWNER", levelScore: 5, phone: OTHER_PHONE },
  ] }] };
  const before = structuredClone(original);
  const msg = { req: { route: { path: "/lk/communities" }, headers: {} }, statusCode: 200, payload: original };
  run(responsePrivacySource(), msg);
  assert.equal(msg.statusCode, 200);
  assert.equal(msg.payload.communities[0].members.length, 2);
  assert.equal(msg.payload.communities[0].members[0].id, "real-user-id");
  assert.equal(msg.payload.communities[0].members[1].name, "Игрок");
  assert.equal(msg.payload.communities[0].members[1].role, "OWNER");
  assert.match(msg.payload.communities[0].members[1].id, /^pp_[a-f0-9]{32}$/);
  assert.deepEqual(original, before, "egress must not change stored records");
  phoneFree(msg.payload);
});

test("chat GET, send acknowledgement and last-message summary keep identity without contacts", () => {
  const message = { id: "message-id", gameId: "game", sender: { id: "user-1", phoneNorm: PHONE, name: "Игрок", role: "PLAYER" }, relatedPhones: [PHONE, OTHER_PHONE], text: "Привет", createdTs: 12 };
  for (const body of [{ messages: [message], gameId: "game", phone: OTHER_PHONE }, message, { chats: [{ gameId: "game", lastMessage: message }] }]) {
    const msg = { req: { route: { path: "/lk/games/:gameId/chat/messages" }, params: { gameId: "game" } }, _chatActor: { id: "user-1", phoneNorm: PHONE }, payload: body };
    run(responsePrivacySource(), msg);
    phoneFree(msg.payload);
    const projected = msg.payload.messages?.[0] || msg.payload.chats?.[0]?.lastMessage || msg.payload;
    assert.equal(projected.sender.id, "user-1");
    assert.equal(projected.sender.isViewer, true);
    assert.equal(projected.text, "Привет");
    assert.equal(projected.id, "message-id");
  }
});

test("result diagnostics expose status/counts without failure phones or raw error text", () => {
  const output = privacy.project({ latestResult: { score: { left: 12, right: 10 }, vivaSync: { status: "FAILED", totalPlayers: 4, syncedPlayers: 3, failures: [{ phone: PHONE }], lastError: "phone=" + PHONE } } });
  phoneFree(output);
  assert.deepEqual(output.latestResult.vivaSync, { status: "FAILED", totalPlayers: 4, syncedPlayers: 3 });
  assert.equal(output.latestResult.score.left, 12);
});

test("rating, roster, comments and author references share opaque IDs and own-view flags", () => {
  const options = { scope: "community:legacy:community", viewer: { id: "viewer-canonical", phone: PHONE } };
  const member = privacy.project({ members: [{ id: null, name: "Игрок", phone: PHONE }] }, options).members[0];
  const rating = privacy.project({ rows: [{ playerId: PHONE, playerKey: "phone:" + PHONE, playerPhone: PHONE, playerName: "Игрок", overallScore: 42, winRate: 0.5 }] }, { ...options, kind: "rating" }).rows[0];
  const comment = privacy.project({ comments: [{ id: "comment", text: "Текст", authorPhone: PHONE, authorName: "Игрок" }] }, options).comments[0];
  assert.equal(member.id, rating.playerId);
  assert.equal(member.id, rating.playerKey);
  assert.equal(member.id, comment.authorId);
  assert.equal(member.isViewer, true);
  assert.equal(rating.isViewer, true);
  assert.equal(comment.authorIsViewer, true);
  assert.equal(rating.overallScore, 42);
  assert.equal(rating.winRate, 0.5);
  phoneFree({ member, rating, comment });
});

test("tournament graph keeps references and stable IDs through roster reordering", () => {
  const raw = tournament();
  const before = structuredClone(raw);
  const projected = privacy.project(raw, { kind: "tournament" });
  const [first, second] = projected.participants.map((member) => member.id);
  assert.notEqual(first, second);
  assert.equal(projected.rounds[0].matches[0].pair1[0], first);
  assert.equal(projected.rounds[0].matches[0].pair2[0], second);
  assert.equal(projected.rounds[0].byes[0], first);
  assert.equal(projected.params.pairAssignments[0][0], first);
  assert.equal(projected.params.readyParticipantIds[0], first);
  assert.equal(projected.params.participantReadyIds[first], true);
  assert.equal(projected.totals[first].points, 12);
  assert.equal(projected.playerLogs[first][0].scoreFor, 12);
  assert.equal(projected.standings[0].id, first);
  raw.participants.reverse();
  assert.equal(privacy.project(raw, { kind: "tournament" }).participants[1].id, first);
  assert.deepEqual(before.participants, raw.participants.toReversed());
  phoneFree(projected);
});

test("continue/offline retry/finish references resolve only in the original tournament and tenant", () => {
  const raw = tournament();
  const safe = privacy.project(raw, { kind: "tournament" });
  const command = { tournamentId: raw.tournamentId, results: [{ roundId: "round-2", pair1: [safe.participants[0].id], pair2: [safe.participants[1].id], score1: 10, score2: 8 }], params: safe.params };
  const restored = privacy.restore(command, raw, scope);
  assert.deepEqual(restored.results[0].pair1, [PHONE]);
  assert.deepEqual(restored.params.pairAssignments, [[PHONE, OTHER_PHONE]]);
  assert.deepEqual(privacy.restore(command, raw, scope), restored, "offline retry must resolve the same identities");
  assert.throws(() => privacy.restore(command, raw, "tournament:other-tenant:synthetic-tournament"), /PUBLIC_IDENTITY_UNKNOWN/);
  assert.throws(() => privacy.restore(command, raw, "tournament:synthetic-tenant:other-tournament"), /PUBLIC_IDENTITY_UNKNOWN/);
  assert.throws(() => privacy.restore({ results: [{ pair1: ["pp_" + "a".repeat(32)] }] }, raw, scope), /PUBLIC_IDENTITY_UNKNOWN/);
  assert.equal(raw.participants[0].phone, PHONE);
});

test("server resave keeps hidden phones for existing canonical and phone-only participants", () => {
  const raw = tournament(); raw.participants.push({ id: "canonical", phone: OTHER_PHONE, name: "Третий" });
  const safe = privacy.project(raw, { kind: "tournament" });
  const msg = { req: { body: safe }, _phonePrivacyCommand: { ...safe, participants: safe.participants.map((row) => ({ ...row, phone: null })) }, payload: [raw] };
  const result = run(tournamentRestorePrivacySource("save"), msg);
  assert.equal(result[1], null);
  assert.equal(msg.payload.participants[0].id, PHONE);
  assert.equal(msg.payload.participants[0].phone, PHONE);
  assert.equal(msg.payload.participants[2].id, "canonical");
  assert.equal(msg.payload.participants[2].phone, OTHER_PHONE);
  assert.equal(msg.payload.organizer.phone, PHONE);
});

test("phone-only community moderation target resolves inside server without changing authorization", () => {
  const raw = { id: "community", members: [{ id: null, phone: PHONE, name: "Игрок" }] };
  const safe = privacy.project(raw);
  const actor = { id: safe.members[0].id, phone: null };
  const msg = { req: { body: { actor: structuredClone(actor), member: { id: safe.members[0].id, phone: null } } }, _communityMemberManage: { actor: structuredClone(actor), member: { id: safe.members[0].id, phone: null } }, payload: [raw] };
  const result = run(communityRestorePrivacySource(), msg);
  assert.equal(result[1], null);
  assert.equal(msg._communityMemberManage.member.phone, PHONE);
  assert.equal(msg._communityMemberManage.member.id, null);
  assert.deepEqual(msg._communityMemberManage.actor, actor, "a public alias must never turn into a private actor credential");
  assert.deepEqual(msg.req.body.actor, actor);
  assert.equal(msg.payload[0], raw, "DB document must stay untouched");
});

test("old raw cached history is projected on every response; missing key never emits a phone ID", () => {
  const cached = [tournament()];
  const msg = { req: { route: { path: "/lk/tournaments/americano/history" } }, payload: cached, statusCode: 200 };
  run(responsePrivacySource(), msg);
  phoneFree(msg.payload);
  assert.equal(cached[0].participants[0].phone, PHONE);
  const denied = { req: msg.req, payload: cached };
  run(responsePrivacySource(), denied, "");
  assert.equal(denied.statusCode, 503);
  phoneFree(denied.payload);
});

test("CSV and XLSX input is projected before the format encoder", () => {
  const raw = tournament();
  const msg = { req: { query: { format: "csv" } }, payload: [raw] };
  assert.equal(run(tournamentExportPrivacySource(), msg)[1], null);
  phoneFree(msg.payload);
  const exportSource = fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_export.js", "utf8");
  vm.runInNewContext(`(function(msg) { ${exportSource}\n })(msg)`, { msg, global: { get() {} } });
  assert.match(msg.payload, /pp_[a-f0-9]{32}/);
  assert.equal(msg.payload.includes(PHONE), false);
  assert.match(msg.payload, /Первый/);
  const sheetRows = [];
  const xlsxMsg = { req: { query: { format: "xlsx" } }, payload: [raw] };
  run(tournamentExportPrivacySource(), xlsxMsg);
  const XLSX = { utils: { book_new: () => ({}), json_to_sheet: (rows) => { sheetRows.push(rows); return {}; }, book_append_sheet() {} }, write: () => Buffer.from("synthetic-xlsx") };
  vm.runInNewContext(`(function(msg) { ${exportSource}\n })(msg)`, { msg: xlsxMsg, global: { get: () => XLSX } });
  phoneFree(sheetRows);
  assert.equal(sheetRows[1][0].playerName, "Первый");
  assert.match(sheetRows[1][0].playerId, /^pp_/);
});

test("composite legacy keys remain distinct and resolve without breaking UUID identifiers", () => {
  const raw = tournament();
  raw.startRatingChanges = [{ eventId: "rating-event:" + PHONE + ":1", player: { participantId: PHONE } }, { eventId: "rating-event:" + OTHER_PHONE + ":1", player: { participantId: OTHER_PHONE } }];
  const safe = privacy.project(raw, { kind: "tournament" });
  phoneFree(safe);
  assert.notEqual(safe.startRatingChanges[0].eventId, safe.startRatingChanges[1].eventId);
  const restored = privacy.restore(safe, raw, scope);
  assert.equal(restored.startRatingChanges[0].eventId, raw.startRatingChanges[0].eventId);
});

test("safe UUIDs, same-name authors and a phone-shaped UUID span survive projection", () => {
  const uuid = "aaaa7999-0000-0001-bbbb-aaaaaaaaaaaa";
  const output = privacy.project({ members: [{ id: uuid, name: "Игрок", phone: PHONE }, { id: "second-id", name: "Игрок", phone: OTHER_PHONE }] });
  assert.equal(output.members[0].id, uuid);
  assert.equal(output.members[1].id, "second-id");
  phoneFree(output);
});

test("already-issued opaque aliases survive repeated projection and still resolve", () => {
  // This real HMAC output contains a coincidental phone-shaped digit sequence.
  const raw = tournament();
  raw.tournamentId = "scope-240";
  const safe = privacy.project(raw, { kind: "tournament" });
  assert.equal(safe.participants[0].id, "pp_d8a1097dbf33bfd30898f81956957728");
  const repeated = privacy.project(safe, { kind: "tournament" });
  assert.deepEqual(repeated, safe);
  const restored = privacy.restore(repeated, raw, "tournament:synthetic-tenant:scope-240");
  assert.equal(restored.participants[0].id, PHONE);
  assert.equal(restored.rounds[0].matches[0].pair1[0], PHONE);
  assert.equal(restored.totals[PHONE].points, 12);
  phoneFree(repeated);
});

test("BSON document identities keep their wire format across projection and JSON round trips", () => {
  const id = new ObjectId("aaaa" + "70000000003" + "b".repeat(9));
  const original = { messages: [{ _id: id, id: id.toHexString(), text: "Привет", authorPhone: PHONE }] };
  const projected = privacy.project(original, { kind: "chat" });
  assert.equal(projected.messages[0]._id, id);
  assert.equal(projected.messages[0].id, id.toHexString());
  const json = JSON.parse(JSON.stringify(projected));
  assert.equal(json.messages[0]._id, id.toHexString());
  assert.deepEqual(privacy.project(json, { kind: "chat" }), json);
  phoneFree(json);
  phoneFree(privacy.project({ metadata: { _bsontype: "ObjectId", toHexString: "not-a-function", phone: PHONE } }));
});

test("successful split payment replies preserve provider references without exposing roster contacts", () => {
  const references = {
    paymentUrl: "https://pay.example.invalid/checkout/70000000003?orderId=70000000003",
    bookingId: "70000000003", transactionId: "70000000004", productId: "70000000005", exerciseId: "70000000006",
  };
  for (const path of ["/lk/games/split/create", "/lk/games/:gameId/split/join", "/lk/games/game-id/split/join"]) {
    const msg = { req: { method: "POST", route: { path } }, statusCode: 201,
      payload: { ...references, participants: [{ id: PHONE, phone: PHONE }], metadata: { transactionId: PHONE } } };
    run(responsePrivacySource(), msg);
    assert.equal(msg.statusCode, 201);
    for (const [field, value] of Object.entries(references)) assert.equal(msg.payload[field], value, field);
    assert.match(msg.payload.participants[0].id, /^pp_/);
    assert.match(msg.payload.metadata.transactionId, /^pp_/);
    phoneFree(msg.payload);
  }
});

test("payment reference exceptions cannot bypass normal roster or error projection", () => {
  const paymentUrl = "https://pay.example.invalid/checkout/70000000003?phone=" + PHONE;
  const ok = { req: { method: "POST", route: { path: "/lk/games/split/create" } }, statusCode: 201, payload: { paymentUrl } };
  run(responsePrivacySource(), ok);
  assert.equal(ok.payload.paymentUrl, "https://pay.example.invalid/checkout/70000000003?phone=[redacted]");
  phoneFree(ok.payload);
  for (const request of [
    { method: "GET", path: "/lk/games/split/create", status: 200 },
    { method: "POST", path: "/lk/games/split/create", status: 400 },
    { method: "POST", path: "/lk/games/game-id/join", status: 201 },
  ]) {
    const msg = { req: { method: request.method, route: { path: request.path } }, statusCode: request.status,
      payload: { transactionId: PHONE, paymentUrl: "https://example.invalid/" + PHONE } };
    run(responsePrivacySource(), msg);
    phoneFree(msg.payload);
  }
});

test("confirmed subscription replays keep the original payment references", () => {
  const paymentUrl = "https://pay.example.invalid/checkout/70000000003?orderId=70000000003";
  for (const path of ["/lk/games/split/create", "/lk/games/:gameId/split/join", "/lk/subscription-bookings"]) {
    const msg = { req: { method: "POST", route: { path } }, statusCode: 200,
      _subscriptionBooking: { lk1IngressReplay: true, lk1: {} },
      payload: { state: "CONFIRMED", paymentUrl, transactionId: "70000000003", toPay: 100 } };
    run(responsePrivacySource(), msg);
    assert.equal(msg.statusCode, 200);
    assert.equal(msg.payload.paymentUrl, paymentUrl);
    assert.equal(msg.payload.transactionId, "70000000003");
    assert.equal(msg.payload.toPay, 100);
  }
  const unrecognized = { req: { method: "POST", route: { path: "/lk/subscription-bookings" } }, statusCode: 200,
    payload: { state: "CONFIRMED", paymentUrl: "https://example.invalid/" + PHONE, transactionId: PHONE } };
  run(responsePrivacySource(), unrecognized);
  phoneFree(unrecognized.payload);
});

test("new subscription checkout responses preserve only the matching server-owned references", () => {
  const checkout = { paymentUrl: "https://pay.example.invalid/checkout/70000000003", transactionId: "70000000003" };
  const original = { req: { method: "POST", route: { path: "/lk/subscription-bookings" } }, statusCode: 200,
    _subscriptionBooking: { step: "lk1_checkout_saved", lk1: { checkout } },
    payload: { ok: true, state: "CONFIRMED", ...checkout, bookingId: "70000000004", exerciseId: "70000000005", toPay: 100 } };
  const msg = structuredClone(original);
  run(responsePrivacySource(), msg);
  assert.deepEqual(JSON.parse(JSON.stringify(msg.payload)), original.payload);
  for (const mismatch of [{ paymentUrl: "https://example.invalid/" + PHONE }, { transactionId: PHONE }]) {
    const inconsistent = structuredClone(original);
    Object.assign(inconsistent.payload, mismatch);
    run(responsePrivacySource(), inconsistent);
    phoneFree(inconsistent.payload);
  }
});

test("game payment records keep numeric provider IDs while member identity remains private", () => {
  const references = { bookingId: "1234567890", transactionId: "1234567891", productId: "1234567892", exerciseId: "1234567893" };
  const game = { id: "game", payment: { ...references, phone: PHONE },
    metadata: { splitPayment: { payments: [{ ...references, clientId: PHONE, phone: PHONE }] } },
    "metadata.splitPayment.payments": [{ transactionId: PHONE }],
    participants: [{ id: PHONE, phone: PHONE, payment: { transactionId: PHONE } }] };
  for (const source of [game, { games: [game] }, { game }, { items: [game] }]) {
    const projected = privacy.project(source, { kind: "game" });
    const row = projected.games?.[0] || projected.game || projected.items?.[0] || projected;
    for (const [field, value] of Object.entries(references)) {
      assert.equal(row.payment[field], value);
      assert.equal(row.metadata.splitPayment.payments[0][field], value);
    }
    assert.match(row.metadata.splitPayment.payments[0].clientId, /^pp_/);
    phoneFree(projected);
  }
  phoneFree(privacy.project({ metadata: { game: { id: "nested", payment: { transactionId: PHONE } } } }, { kind: "game" }));
  phoneFree(privacy.project({ payment: { transactionId: PHONE } }, { kind: "game" }));
});

test("projected game bookings remain bound to payment confirmation readback", () => {
  const bookingId = "1234567890";
  const placements = [
    ["booking", "bookingId"], ["booking", "bookingIds"], ["metadata", "bookingIds"], ["payment", "bookingIds"],
    ["metadata", "splitPayment", "payments", "bookingId"], ["metadata", "splitPayment", "payments", "bookingIds"],
  ];
  for (const fields of placements) {
    const raw = { id: "game", metadata: { paymentRef: "synthetic-payment-ref" } };
    let row = raw;
    for (const field of fields.slice(0, -1)) {
      if (field === "payments") { row[field] = [{}]; row = row[field][0]; }
      else { row[field] ||= {}; row = row[field]; }
    }
    row[fields.at(-1)] = fields.at(-1) === "bookingIds" ? [bookingId] : bookingId;
    const expected = { gameId: raw.id, paymentRef: raw.metadata.paymentRef, bookingIds: [bookingId] };
    assert.equal(isConfirmedPaymentReadbackBound(raw, expected), true);
    const safe = privacy.project(raw, { kind: "game" });
    assert.equal(isConfirmedPaymentReadbackBound(safe, expected), true, fields.join("."));
    assert.equal(isConfirmedPaymentReadbackBound(safe, { ...expected, bookingIds: ["foreign-booking"] }), false);
  }
});

test("canonical alternate IDs, tournament metadata and pending-member identity survive", () => {
  const output = privacy.project({ tournamentId: "t", tenantKey: "tenant", title: "Турнир", maxParticipants: 8, girlsOnly: true,
    participants: [{ clientId: "real-client", phone: PHONE, name: "Игрок", spot: 2, isCancelled: true }],
  }, { kind: "tournament" });
  assert.equal(output.participants[0].id, "real-client");
  assert.equal(output.participants[0].spot, 2);
  assert.equal(output.participants[0].isCancelled, true);
  assert.equal(output.title, "Турнир");
  assert.equal(output.maxParticipants, 8);
  assert.equal(output.girlsOnly, true);
  assert.match(privacy.project({ pendingMembers: [{ phone: PHONE }] }).pendingMembers[0].id, /^pp_/);
});

test("anonymous game reads keep roster fields and hide legacy result fingerprints consistently", () => {
  const game = { id: "game", participants: [{ id: "client", name: "Игрок", level: 4, paymentStatus: "PAID" }],
    metadata: { resultSession: { initialTeamMemberKeys: ["rm_oldkey"], openedBy: { memberKey: "rm_oldkey" } } } };
  const detail = { req: { route: { path: "/lk/games/:gameId" }, params: { gameId: "game" }, headers: {} }, payload: game, statusCode: 200 };
  const list = { req: { route: { path: "/lk/games" }, headers: {} }, payload: { games: [game] }, statusCode: 200 };
  run(responsePrivacySource(), detail); run(responsePrivacySource(), list);
  assert.equal(detail.statusCode, 200);
  assert.equal(list.statusCode, 200);
  assert.equal(detail.payload.participants[0].paymentStatus, "PAID");
  const id = detail.payload.metadata.resultSession.initialTeamMemberKeys[0];
  assert.match(id, /^pp_/);
  assert.equal(list.payload.games[0].metadata.resultSession.openedBy.memberKey, id);
  assert.equal(JSON.stringify(detail.payload).includes("rm_oldkey"), false);
});

test("legacy result keys are wrapped in scoped HMAC and restored only in lineup targets", () => {
  const raw = { id: "game", resultRosterSnapshot: { members: [{ memberKey: "phone:" + PHONE, phoneNorm: PHONE, name: "Игрок" }] } };
  let hash = 2166136261;
  for (const letter of "phone:" + PHONE) { hash ^= letter.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const old = "rm_" + (hash >>> 0).toString(36);
  const safe = privacy.project({ memberKey: old }, { scope: "game:legacy:game" }).memberKey;
  const actor = { id: safe, phone: OTHER_PHONE };
  const msg = { payload: [raw], _resultSubmit: { gameId: "game", actor: structuredClone(actor), idempotencyKey: "retry-1",
    setPairings: [{ setIndex: 0, teamSlots: [{ memberKey: safe }, safe] }],
    rosterSnapshot: { initialTeamMemberKeys: [safe], initialTeamSlots: [{ memberKey: safe }] }, sets: [{ left: 6, right: 4 }] } };
  assert.equal(run(resultRestorePrivacySource("submit"), msg)[1], null);
  assert.equal(msg._resultSubmit.setPairings[0].teamSlots[0].memberKey, old);
  assert.equal(msg._resultSubmit.setPairings[0].teamSlots[1], old);
  assert.equal(msg._resultSubmit.rosterSnapshot.initialTeamMemberKeys[0], old);
  assert.deepEqual(msg._resultSubmit.actor, actor);
  assert.equal(msg._resultSubmit.idempotencyKey, "retry-1");
  assert.equal(msg._resultSubmit.sets[0].left, 6);
  const patch = { payload: [{ gameId: "game", resultRosterSnapshot: raw.resultRosterSnapshot }], _resultSessionPatch: {
    actor: structuredClone(actor), expectedRevision: 9, hasDraftPairings: true, draftPairings: [{ teamSlots: [safe, old] }] } };
  assert.equal(run(resultRestorePrivacySource("session"), patch)[1], null);
  assert.deepEqual(Array.from(patch._resultSessionPatch.draftPairings[0].teamSlots), [old, old]);
  assert.deepEqual(patch._resultSessionPatch.actor, actor);
  assert.equal(patch._resultSessionPatch.expectedRevision, 9);
  for (const invalid of ["pp_" + "f".repeat(32), privacy.project({ memberKey: old }, { scope: "game:legacy:other-game" }).memberKey]) {
    const denied = { payload: [raw], _resultSubmit: { actor, setPairings: [{ teamSlots: [invalid] }] } };
    assert.equal(run(resultRestorePrivacySource("submit"), denied)[0], null);
    assert.equal(denied.statusCode, 409);
  }
});
